import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { compileAchengDirector } from "@basketikun/canvas-agent/skills/acheng";
import { canonicalProduction, directorProductionSchema, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { EpisodeProductionService, ProductionConflictError } from "./production.js";

const hash = (value: unknown) => crypto.createHash("sha256").update(canonicalProduction(value)).digest("hex");
type Compiler = typeof compileAchengDirector;

/** Frozen compiler packets are sidecar files; only the existing ops transaction edits production. */
export class ProductionCompilationService {
    constructor(private service: EpisodeProductionService, private root: string, private compiler: Compiler = compileAchengDirector) {}

    private file(preparedId: string) {
        if (!/^[a-f0-9-]{36}$/.test(preparedId)) throw new Error("Invalid compilation handle");
        return path.join(this.root, preparedId, "packet.json");
    }

    prepare(id: string, owner: string, expectedRevision: number, candidate?: DirectorProduction) {
        const current = this.service.get(id);
        if (current.revision !== expectedRevision) throw new ProductionConflictError(current);
        if (!current.draft.director) throw new Error("Missing formal director source");
        const director = directorProductionSchema.parse(structuredClone(candidate || current.draft.director));
        if (hash(director.engine) !== hash(current.draft.director.engine)) throw new Error("Compilation must use the production's pinned engine");
        this.service.verifyCompilationBindings(id, director);
        const preparedId = crypto.randomUUID();
        const directory = path.join(this.root, preparedId);
        const compiled = this.compiler(director, directory, (targetId, label) => this.service.compilationReferenceFile(id, director, targetId, label));
        if (compiled.director.workflow.currentWork) {
            compiled.director.workflow.currentWork = { ...compiled.director.workflow.currentWork, inputRevision: expectedRevision, sourceHash: compiled.director.sourceHash };
        }
        if (hash(this.service.get(id).draft.director) !== hash(current.draft.director) || this.service.get(id).revision !== expectedRevision) throw new ProductionConflictError(this.service.get(id));
        const packet = { owner, id, expectedRevision, baselineHash: hash(current.draft.director), operationId: `compilation:${preparedId}`, resultHash: hash(compiled.director), ...compiled };
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(this.file(preparedId), JSON.stringify({ ...packet, packetHash: hash(packet) }), { encoding: "utf8", flag: "wx" });
        return { preparedId, operationId: packet.operationId, expectedRevision, sourceHash: compiled.director.sourceHash, engine: director.engine, diagnostics: compiled.diagnostics,
            audit: compiled.audit, sourceAdjustments: compiled.sourceAdjustments, targets: compiled.director.artifacts.map(a => ({ id: a.id, targetId: a.targetId, kind: a.kind, status: a.status, sha256: a.sha256, references: a.references, diagnostics: a.receipt.diagnostics })), mediaSubmitted: false };
    }

    apply(id: string, owner: string, preparedId: string) {
        const { packetHash, ...packet } = JSON.parse(fs.readFileSync(this.file(preparedId), "utf8"));
        if (hash(packet) !== packetHash) throw new Error("Frozen compilation bytes changed");
        if (packet.owner !== owner || packet.id !== id) throw new Error("Compilation belongs to a different production");
        if (hash(packet.director) !== packet.resultHash) throw new Error("Frozen compilation bytes changed");
        if (packet.diagnostics.some((d: { severity: string }) => d.severity === "error")) throw new Error("Compilation has unresolved errors; correct its source and prepare a new packet");
        const current = this.service.get(id);
        // Let the ops service recover an already committed operation before its revision check.
        if (current.revision === packet.expectedRevision) {
            if (hash(current.draft.director) !== packet.baselineHash) throw new ProductionConflictError(current);
            this.service.verifyCompilationBindings(id, packet.director);
        }
        const result = this.service.edit(id, { operationId: packet.operationId, expectedRevision: packet.expectedRevision, ops: [{ type: "set_director_production", director: packet.director }] });
        return { revision: result.revision, replayed: result.replayed === true, publishedVersion: result.publishedVersion, sourceHash: result.draft.director?.sourceHash, operationId: packet.operationId, mediaSubmitted: false };
    }
}
