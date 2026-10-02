import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { z } from "zod/v4";

/**
 * Bridge object-form Draft-7 JSON Schema to the SDK's Zod input API.
 *
 * Zod's JSON Schema export cannot reconstruct cross-field refinements. Keep the
 * declaration as Zod 4 metadata (which the installed SDK exports verbatim), and
 * validate with the same AJV engine used by the SDK, rather than a lossy conversion.
 * The outer loose object preserves arguments; AJV alone owns field validation.
 * Unsupported dialects/keywords and unresolved references fail at registration.
 */
export function compilePluginInputSchema(schema: Record<string, unknown>) {
    if (schema.type !== undefined && schema.type !== "object") {
        throw new Error("Plugin MCP input schema must describe an object");
    }
    const declaration = structuredClone(schema);
    // Use a compiler per declaration: reusing $id must not reuse an older schema
    // after a plugin upgrade. No coercion, default insertion or field removal.
    const ajv = new Ajv({
        strictSchema: true,
        strictTypes: false,
        strictTuples: false,
        strictRequired: false,
        allErrors: true,
        verbose: true,
        coerceTypes: false,
        useDefaults: false,
        removeAdditional: false,
    });
    const applyFormats = addFormats as unknown as (instance: Ajv) => void;
    applyFormats(ajv);
    const validate = ajv.compile(declaration);
    return {
        inputSchema: z.object({}).passthrough().meta(declaration),
        validateInput(input: Record<string, unknown>) {
            if (!validate(input)) {
                // Select only repair details; verbose AJV errors also contain the
                // caller's data/full schema, which must never cross this boundary.
                const issues = (validate.errors || []).map((error) => {
                    const path = error.instancePath.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
                    const property = error.params.missingProperty ?? error.params.additionalProperty;
                    if (typeof property === "string") path.push(property);
                    const allowedFields = error.keyword === "additionalProperties" && error.parentSchema?.properties
                        ? Object.keys(error.parentSchema.properties) : undefined;
                    return { code: error.keyword, path, message: `${path.join(".") || "input"}: ${error.message || "invalid value"}`, ...(allowedFields ? { allowedFields } : {}) };
                });
                throw Object.assign(new Error(`Invalid plugin MCP input: ${issues.map((issue) => issue.message).join("; ")}`), {
                    code: "INVALID_INPUT", handlerInvoked: false, issues,
                });
            }
        },
    };
}
