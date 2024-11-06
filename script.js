import sqlite3InitModule from "https://esm.sh/@sqlite.org/sqlite-wasm@3.46.1-build3";
import { render, html } from "https://cdn.jsdelivr.net/npm/lit-html@3/+esm";
import { asyncLLM } from "https://cdn.jsdelivr.net/npm/asyncllm@1";
import { unsafeHTML } from "https://cdn.jsdelivr.net/npm/lit-html@3/directives/unsafe-html.js";
import { dsvFormat, autoType } from "https://cdn.jsdelivr.net/npm/d3-dsv@3/+esm";
import { Marked } from "https://cdn.jsdelivr.net/npm/marked@13/+esm";

const $upload = document.getElementById("upload");
const $prompt = document.getElementById("prompt");
const $schema = document.getElementById("schema");
const $toast = document.getElementById("toast");
const toast = new bootstrap.Toast($toast);
const $queryForm = document.getElementById("query-form");

// Initialize SQLite
const defaultDB = "@";
const sqlite3 = await sqlite3InitModule({ printErr: console.error });

// --------------------------------------------------------------------
// Manage database tables
const db = new sqlite3.oo1.DB(defaultDB, "c");
const DB = {
  schema: function () {
    let tables = [];
    db.exec("SELECT name, sql FROM sqlite_master WHERE type='table'", { rowMode: "object" }).forEach((table) => {
      table.columns = db.exec(`PRAGMA table_info(${table.name})`, { rowMode: "object" });
      tables.push(table);
    });
    return tables;
  },

  // Recommended questions for the current schema
  questionInfo: {},
  questions: async function () {
    if (DB.questionInfo.schema !== JSON.stringify(DB.schema())) {
      const response = await llm({
        system: "Suggest 5 diverse, useful questions that a user can answer from this dataset using SQLite",
        user: DB.schema()
          .map(({ sql }) => sql)
          .join("\n\n"),
        schema: {
          type: "object",
          properties: { questions: { type: "array", items: { type: "string" }, additionalProperties: false } },
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
    if (file.name.match(/\.(sqlite3|sqlite|db|s3db|sl3)$/i)) await DB.uploadSQLite(file);
    else if (file.name.match(/\.csv$/i)) await DB.uploadDSV(file, ",");
    else if (file.name.match(/\.tsv$/i)) await DB.uploadDSV(file, "\t");
    else notify("danger", `Unknown file type: ${file.name}`);
  },

  uploadSQLite: async function (file) {
    const fileReader = new FileReader();
    await new Promise((resolve) => {
      fileReader.onload = async (e) => {
        await sqlite3.capi.sqlite3_js_posix_create_file(file.name, e.target.result);
        // Copy tables from the uploaded database to the default database
        const uploadDB = new sqlite3.oo1.DB(file.name, "r");
        const tables = uploadDB.exec("SELECT name, sql FROM sqlite_master WHERE type='table'", { rowMode: "object" });
        for (const { name, sql } of tables) {
          try {
            db.exec(sql);
          } catch (e) {
            console.error(e);
            notify("danger", e);
            continue;
          }
          const data = uploadDB.exec(`SELECT * FROM "${name}"`, { rowMode: "object" });
          if (data.length > 0) {
            const columns = Object.keys(data[0]);
            const sql = `INSERT INTO "${name}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns
              .map(() => "?")
              .join(", ")})`;
            const stmt = db.prepare(sql);
            db.exec("BEGIN TRANSACTION");
            for (const row of data) stmt.bind(columns.map((c) => row[c])).stepReset();
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
        if (typeof sampleValue === "number") sqlType = Number.isInteger(sampleValue) ? "INTEGER" : "REAL";
        else if (typeof sampleValue === "boolean") sqlType = "INTEGER"; // SQLite has no boolean
        else if (sampleValue instanceof Date) sqlType = "TEXT"; // Store dates as TEXT
        return [col, sqlType];
      })
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
          })
        )
        .stepReset();
    }
    db.exec("COMMIT");
    stmt.finalize();
  },
};

$upload.addEventListener("change", async (e) => {
  notify("info", "Loading", /* html */ `Importing data <div class='spinner-border spinner-border-sm'></div>`);
  const uploadPromises = Array.from(e.target.files).map((file) => DB.upload(file));
  await Promise.all(uploadPromises);
  notify("success", "Imported", `Imported all files`);
  drawTables();
});

// --------------------------------------------------------------------
// Render tables

async function drawTables() {
  const schema = DB.schema();

  const tables = html`
    <div class="accordion" id="table-accordion" style="--bs-accordion-btn-padding-y: 0.5rem">
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
                      `
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      `
      )}
    </div>
  `;
  render([tables], $schema);
}

function notify(cls, title, message) {
  $toast.querySelector(".toast-title").textContent = title;
  $toast.querySelector(".toast-body").innerHTML = message;
  const $toastHeader = $toast.querySelector(".toast-header");
  $toastHeader.classList.remove("text-bg-success", "text-bg-danger", "text-bg-warning", "text-bg-info");
  $toastHeader.classList.add(`text-bg-${cls}`);
  toast.show();
}

// --------------------------------------------------------------------
// Query form

$queryForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const data = new FormData($queryForm);
  let schema = DB.schema();
  if (!schema.length) await autoload();
  schema = DB.schema();
  schema = schema
    .map(({ sql }) => sql)
    .join("\n\n");

  for await (const { content, tool, args } of asyncLLM("https://llmfoundry.straive.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      model: "gpt-4o-mini",
      stream: true,
      messages: [
        { role: "system", content: data.get("prompt").replace("$SCHEMA", schema) },
        { role: "user", content: data.get("q") },
      ],
      tool_choice: "required",
      tools: [
        {
          type: "function",
          function: {
            name: "sql",
            description: "Run an SQL query. Return { count: number, results: [{}, ...] }",
            parameters: {
              type: "object",
              properties: { query: { type: "string", description: "The SQL query to run." } },
              required: ["query"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "similar",
            description: "Get the most similar values to a given input from a table's column. Return [value, ...]",
            parameters: {
              type: "object",
              properties: {
                table: { type: "string", description: "The table to search in." },
                column: { type: "string", description: "The column to search in." },
                input: { type: "string", description: "The input to search for." },
              },
              required: ["table", "column", "input"],
            },
          },
        },
      ],
    }),
  })) {
    console.log(content, tool, args);
    // Update the output in real time.
    // document.getElementById("output").textContent = content;
  }
});


function saveFormState($form, formKey) {
  // When the page loads, restore the form state from localStorage
  for (const [key, value] of Object.entries(JSON.parse(localStorage[formKey] || "{}"))) {
    const input = $form.querySelector(`[name="${key}"]`);
    if (!input) continue;
    if (input.matches("textarea, select, input[type=range], input[type=text]")) input.value = value;
    else if (input.matches("input[type=checkbox]")) input.checked = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // When form is changed, save the form state to localStorage
  $form.addEventListener(
    "input",
    () => (localStorage[formKey] = JSON.stringify(Object.fromEntries(new FormData($form))))
  );
  // When form is reset, also clear localStorage
  $form.addEventListener("reset", () => (localStorage[formKey] = "{}"));
}

saveFormState($queryForm, "cocoagpt");


async function autoload() {
  notify("info", "Loading", /* html */ `Loading default datasets <div class='spinner-border spinner-border-sm'></div>`);

  try {
    // Fetch the SQLite database
    const dbResponse = await fetch("barry-callebout-data.db");
    const dbBlob = await dbResponse.blob();
    const dbFile = new File([dbBlob], "barry-callebout-data.db");

    // Fetch the CSV file
    const csvResponse = await fetch("metadata.csv");
    const csvBlob = await csvResponse.blob();
    const csvFile = new File([csvBlob], "metadata.csv");

    // Upload both files using existing DB methods
    await Promise.all([
      DB.upload(dbFile),
      DB.upload(csvFile)
    ]);

    notify("success", "Loaded", "Default datasets imported successfully");
    drawTables();
  } catch (error) {
    console.error(error);
    notify("danger", "Error", "Failed to load default datasets");
  }
}
