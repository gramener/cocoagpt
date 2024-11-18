import sqlite3InitModule from "https://esm.sh/@sqlite.org/sqlite-wasm@3.46.1-build3";
import { html } from "https://cdn.jsdelivr.net/npm/lit-html@3/+esm";
import {
  dsvFormat,
  autoType,
} from "https://cdn.jsdelivr.net/npm/d3-dsv@3/+esm";

// Initialize SQLite
export const defaultDB = "@";
export const sqlite3 = await sqlite3InitModule({ printErr: console.error });

export const db = new sqlite3.oo1.DB(defaultDB, "c");
export const DB = {
  schema: function () {
    let tables = [];
    db.exec("SELECT name, sql FROM sqlite_master WHERE type='table'", {
      rowMode: "object",
    }).forEach((table) => {
      table.columns = db.exec(`PRAGMA table_info(${table.name})`, {
        rowMode: "object",
      });
      tables.push(table);
    });
    return tables;
  },

  // Recommended questions for the current schema
  questionInfo: {},
  questions: async function () {
    if (DB.questionInfo.schema !== JSON.stringify(DB.schema())) {
      const response = await llm({
        system:
          "Suggest 5 diverse, useful questions that a user can answer from this dataset using SQLite",
        user: DB.schema()
          .map(({ sql }) => sql)
          .join("\n\n"),
        schema: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              items: { type: "string" },
              additionalProperties: false,
            },
          },
          required: ["questions"],
          additionalProperties: false,
        },
      });
      if (response.error) DB.questionInfo.error = response.error;
      else DB.questionInfo.questions = response.questions;
      DB.questionInfo.schema = JSON.stringify(DB.schema());
    }
    return DB.questionInfo;
  },

  upload: async function (file) {
    if (file.name.match(/\.(sqlite3|sqlite|db|s3db|sl3)$/i))
      await DB.uploadSQLite(file);
    else if (file.name.match(/\.csv$/i)) await DB.uploadDSV(file, ",");
    else if (file.name.match(/\.tsv$/i)) await DB.uploadDSV(file, "\t");
    else notify("danger", `Unknown file type: ${file.name}`);
  },

  uploadSQLite: async function (file) {
    const fileReader = new FileReader();
    await new Promise((resolve) => {
      fileReader.onload = async (e) => {
        await sqlite3.capi.sqlite3_js_posix_create_file(
          file.name,
          e.target.result,
        );
        // Copy tables from the uploaded database to the default database
        const uploadDB = new sqlite3.oo1.DB(file.name, "r");
        const tables = uploadDB.exec(
          "SELECT name, sql FROM sqlite_master WHERE type='table'",
          { rowMode: "object" },
        );
        for (const { name, sql } of tables) {
          try {
            db.exec(sql);
          } catch (e) {
            console.error(e);
            notify("danger", e);
            continue;
          }
          const data = uploadDB.exec(`SELECT * FROM "${name}"`, {
            rowMode: "object",
          });
          if (data.length > 0) {
            const columns = Object.keys(data[0]);
            const sql = `INSERT INTO "${name}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns
              .map(() => "?")
              .join(", ")})`;
            const stmt = db.prepare(sql);
            db.exec("BEGIN TRANSACTION");
            for (const row of data)
              stmt.bind(columns.map((c) => row[c])).stepReset();
            db.exec("COMMIT");
            stmt.finalize();
          }
        }
        uploadDB.close();
        resolve();
      };
      fileReader.readAsArrayBuffer(file);
    });
  },

  uploadDSV: async function (file, separator) {
    const fileReader = new FileReader();
    const result = await new Promise((resolve) => {
      fileReader.onload = (e) => {
        const rows = dsvFormat(separator).parse(e.target.result, autoType);
        resolve(rows);
      };
      fileReader.readAsText(file);
    });
    const tableName = file.name.slice(0, -4).replace(/[^a-zA-Z0-9_]/g, "_");
    await DB.insertRows(tableName, result);
  },

  insertRows: async function (tableName, result) {
    // Create table by auto-detecting column types
    const cols = Object.keys(result[0]);
    const typeMap = Object.fromEntries(
      cols.map((col) => {
        const sampleValue = result[0][col];
        let sqlType = "TEXT";
        if (typeof sampleValue === "number")
          sqlType = Number.isInteger(sampleValue) ? "INTEGER" : "REAL";
        else if (typeof sampleValue === "boolean")
          sqlType = "INTEGER"; // SQLite has no boolean
        else if (sampleValue instanceof Date) sqlType = "TEXT"; // Store dates as TEXT
        return [col, sqlType];
      }),
    );
    const createTableSQL = `CREATE TABLE IF NOT EXISTS ${tableName} (${cols
      .map((col) => `[${col}] ${typeMap[col]}`)
      .join(", ")})`;
    db.exec(createTableSQL);

    // Insert data
    const insertSQL = `INSERT INTO ${tableName} (${cols.map((col) => `[${col}]`).join(", ")}) VALUES (${cols
      .map(() => "?")
      .join(", ")})`;
    const stmt = db.prepare(insertSQL);
    db.exec("BEGIN TRANSACTION");
    for (const row of result) {
      stmt
        .bind(
          cols.map((col) => {
            const value = row[col];
            return value instanceof Date ? value.toISOString() : value;
          }),
        )
        .stepReset();
    }
    db.exec("COMMIT");
    stmt.finalize();
  },
};

export const tables = (schema) => html`
  <div
    class="accordion"
    id="table-accordion"
    style="--bs-accordion-btn-padding-y: 0.5rem"
  >
    ${schema.map(
      ({ name, sql, columns }) => html`
          <div class="accordion-item">
            <h2 class="accordion-header">
              <button
                class="accordion-button collapsed"
                type="button"
                data-bs-toggle="collapse"
                data-bs-target="#collapse-${name}"
                aria-expanded="false"
                aria-controls="collapse-${name}"
              >${name}</button>
            </h2>
            <div
              id="collapse-${name}"
              class="accordion-collapse collapse"
              data-bs-parent="#table-accordion"
            >
              <div class="accordion-body">
                <pre style="white-space: pre-wrap">${sql}</pre>
                <table class="table table-striped table-sm">
                  <thead>
                    <tr>
                      <th>Column Name</th>
                      <th>Type</th>
                      <th>Not Null</th>
                      <th>Default Value</th>
                      <th>Primary Key</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${columns.map(
                      (column) => html`
                        <tr>
                          <td>${column.name}</td>
                          <td>${column.type}</td>
                          <td>${column.notnull ? "Yes" : "No"}</td>
                          <td>${column.dflt_value ?? "NULL"}</td>
                          <td>${column.pk ? "Yes" : "No"}</td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      `,
    )}
  </div>
`;
