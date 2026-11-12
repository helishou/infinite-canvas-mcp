import { DatabaseSync } from "node:sqlite";
import { CURRENT_DATABASE_SCHEMA } from "../database-schema.js";

/** Schema 52 and 53 have identical DDL; only the allowed payload codecs differ. */
export function schema52Database(file: string): DatabaseSync {
    const db = new DatabaseSync(file);
    db.exec(CURRENT_DATABASE_SCHEMA);
    db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(52,?)").run(new Date().toISOString());
    return db;
}
