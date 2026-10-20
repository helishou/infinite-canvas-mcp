import { BackendDatabase } from "./src/db.js";
import { validateSharedAssetSource } from "./src/drama/shared-assets.js";
import { EpisodeProductionService } from "./src/drama/production.js";
import { ProductionCompilationService } from "./src/drama/compilation.js";

const EP = "episode-ZtSuzRl8Co3AF3YFZZ-hn-3-t94z9c";
const db = new BackendDatabase();
const service = new EpisodeProductionService(db);
const coord = new ProductionCompilationService(service, "/tmp", undefined as any);
const canvasId = service.episodeInfo(EP).canvasId;
console.log("canvasId:", canvasId);

const current = service.get(EP);
console.log("AFTER get() nodeId:", current.draft.director.assets['SHARED_production-shared-assets-b71a0291d5f4e8a1edc48cd8_production-entity-dcbf025d20d7fd4aaad5e995']?.nodeId);

const afterCompilationDirector = (coord as any).compilationDirector(current.draft.director);
console.log("AFTER compilationDirector nodeId:", afterCompilationDirector.assets['SHARED_production-shared-assets-b71a0291d5f4e8a1edc48cd8_production-entity-dcbf025d20d7fd4aaad5e995']?.nodeId);

const diagnostics: any[] = [];
const afterResolve = service.resolveSubjectPictureInputs(
  EP,
  afterCompilationDirector,
  undefined,
  true,
  undefined,
  diagnostics
);
console.log("AFTER resolveSubjectPictureInputs nodeId:", afterResolve.assets['SHARED_production-shared-assets-b71a0291d5f4e8a1edc48cd8_production-entity-dcbf025d20d7fd4aaad5e995']?.nodeId);

const afterBind = (coord as any).bindCanvasStyleAnchor(EP, afterResolve);
console.log("AFTER bindCanvasStyleAnchor nodeId:", afterBind.assets['SHARED_production-shared-assets-b71a0291d5f4e8a1edc48cd8_production-entity-dcbf025d20d7fd4aaad5e995']?.nodeId);
