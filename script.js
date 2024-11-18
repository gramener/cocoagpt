import { render, html } from "https://cdn.jsdelivr.net/npm/lit-html@3/+esm";
import { unsafeHTML } from "https://cdn.jsdelivr.net/npm/lit-html@3/directives/unsafe-html.js";
import { asyncLLM } from "https://cdn.jsdelivr.net/npm/asyncllm@2.1";
import {
  num,
  num0,
  num2,
  pc,
  pc0,
  pc1,
} from "https://cdn.jsdelivr.net/npm/@gramex/ui@0.3/dist/format.js";
import { parse } from "https://cdn.jsdelivr.net/npm/partial-json@0.1.7/+esm";
import { Marked } from "https://cdn.jsdelivr.net/npm/marked@13/+esm";
import { db, DB, tables } from "./db.js";

const $upload = document.getElementById("upload");
const $schema = document.getElementById("schema");
const $mainField = document.getElementById("main-field");
const $filters = document.getElementById("filters");
const $results = document.getElementById("results");
const $toast = document.getElementById("toast");
const toast = new bootstrap.Toast($toast);
const $queryForm = document.getElementById("query-form");

const marked = new Marked();
let messages = []; // Global message queue
let metadata; // Global metadata results
let filterData; // Global filter results
const defaultMinSimilarity = 0.4;

const loading = html`<div class="spinner-border"></div>`;

// FormPersistence.persist($queryForm);

// --------------------------------------------------------------------
// Manage database tables

$upload.addEventListener("change", async (e) => {
  notify(
    "info",
    "Loading",
    /* html */ `Importing data <div class='spinner-border spinner-border-sm'></div>`,
  );
  const uploadPromises = Array.from(e.target.files).map((file) =>
    DB.upload(file),
  );
  await Promise.all(uploadPromises);
  notify("success", "Imported", `Imported all files`);
  prepareMetadata();
  drawTables();
});

// --------------------------------------------------------------------
// Render tables

async function drawTables() {
  const schema = DB.schema();
  render(tables(schema), $schema);
}

function notify(cls, title, message) {
  $toast.querySelector(".toast-title").textContent = title;
  $toast.querySelector(".toast-body").innerHTML = message;
  const $toastHeader = $toast.querySelector(".toast-header");
  $toastHeader.classList.remove(
    "text-bg-success",
    "text-bg-danger",
    "text-bg-warning",
    "text-bg-info",
  );
  $toastHeader.classList.add(`text-bg-${cls}`);
  toast.show();
}

// --------------------------------------------------------------------
// Rendering functions

const filterTable = (data) => html`
  <table class="table table-sm">
    <thead>
      <tr>
        <th></th>
        <th>Requirement</th>
        <th>Table</th>
        <th>Column</th>
        <th>Operator</th>
        <th>Value</th>
        <th>Matches</th>
        <th>Similarity</th>
      </tr>
    </thead>
    <tbody>
      ${data?.filters?.map(
        (filter) => html`
          <tr
            data-table="${filter.table}"
            data-column="${filter.column}"
            class="${filter.disabled ? "table-secondary" : ""}"
          >
            <td>
              <input
                type="checkbox"
                class="form-check-input filter-enabled"
                ?checked=${!filter.disabled}
              />
            </td>
            <td>${filter?.requirement}</td>
            <td>${filter?.table}</td>
            <td>${filter?.column}</td>
            <td>${filter?.operator}</td>
            <td>
              <input
                type="text"
                class="form-control form-control-sm filter-value"
                value=${filter?.value ?? ""}
              />
            </td>
            <td class="matches">${renderMatches(filter)}</td>
            <td>
              <input
                type="range"
                class="form-range min-similarity"
                min="0"
                max="1"
                step="0.001"
                value="${defaultMinSimilarity}"
              />
            </td>
          </tr>
        `,
      ) ?? loading}
    </tbody>
  </table>

  <form class="mb-3 d-flex" id="update-filter-form">
    <input
      class="form-control"
      id="update-filter"
      name="update-filter"
      placeholder="Prompt to update the filters"
    />
    <button
      type="submit"
      class="btn btn-primary text-nowrap ms-2"
      id="update-filter-button"
    >
      <i class="bi bi-pencil me-2"></i> Update
    </button>
  </form>

  <div>
    <button class="btn btn-primary" id="apply-filters">
      <i class="bi bi-search me-2"></i> Apply Filters
    </button>
  </div>
`;

const renderMatches = (filter) => {
  if (filter.matches === null) return loading;
  if (!filter.matches?.length) return null;
  filter.minSimilarity =
    $filters.querySelector(
      `tr[data-table="${filter.table}"][data-column="${filter.column}"] .min-similarity`,
    )?.value ?? defaultMinSimilarity;
  const matches = filter.matches.filter(
    ({ score }) => score >= filter.minSimilarity,
  );
  return html`<div class="dropdown">
    <button
      class="btn btn-secondary dropdown-toggle"
      type="button"
      data-bs-toggle="dropdown"
      aria-expanded="false"
    >
      ${matches.length} similar
    </button>
    <ul class="dropdown-menu">
      ${matches
        .toSorted((a, b) => b.score - a.score)
        .map(
          ({ score, value }) =>
            html`<li>
              <a class="dropdown-item" href="#">${value} (${pc(score)})</a>
            </li>`,
        )}
    </ul>
  </div>`;
};

// --------------------------------------------------------------------
// Query form

$queryForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const data = new FormData($queryForm);
  const schema = metadata.table
    .map(
      ({ table, column, type, nunique, top5 }) => `
- Table: ${table}, Column: ${column}, Type: ${type}, ${nunique} unique values. Top 5: ${top5?.replace(/\n/g, ", ")}`,
    )
    .join("\n");

  // --------------------------------------------------------------------
  // Get the filters
  messages = [
    { role: "system", content: data.get("prompt").replace("$SCHEMA", schema) },
    { role: "user", content: data.get("q") },
  ];
  await renderFilterTable(messages);
});

async function renderFilterTable(messages) {
  render(loading, $filters);
  let content;
  for await ({ content } of asyncLLM(
    "https://llmfoundry.straive.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        model: "gpt-4o-mini",
        stream: true,
        messages,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "filters",
            strict: true,
            schema: {
              type: "object",
              properties: {
                filters: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      requirement: {
                        type: "string",
                        description:
                          "Verbatim quote from customer email on the requirement",
                      },
                      table: { type: "string" },
                      column: { type: "string" },
                      operator: {
                        type: "string",
                        enum: ["=", "!=", ">", ">=", "<", "<="],
                      },
                      value: { type: "string" },
                    },
                    required: [
                      "requirement",
                      "table",
                      "column",
                      "operator",
                      "value",
                    ],
                    additionalProperties: false,
                  },
                },
              },
              required: ["filters"],
              additionalProperties: false,
            },
          },
        },
      }),
    },
  )) {
    if (content) {
      filterData = parse(content);
      render([filterTable(filterData), loading], $filters);
    }
  }
  render(filterTable(filterData), $filters);

  for (const filter of filterData.filters) await matchFilter(filter);
}

async function matchFilter(filter) {
  const metadataRow = metadata.table.find(
    ({ table, column }) => table == filter.table && column == filter.column,
  );
  if (!metadataRow) return;
  if (!(metadataRow.category == "enum" || metadataRow.category == "embedding"))
    return;
  const values = db.exec(
    `SELECT DISTINCT ${filter.column} AS value FROM ${filter.table}`,
    { rowMode: "object" },
  );
  filter.matches = null;
  render(filterTable(filterData), $filters);
  const result = await fetch(`https://llmfoundry.straive.com/similarity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      docs: values.map(({ value }) => value),
      topics: [filter.value],
    }),
  }).then((r) => r.json());
  filter.matches = result.similarity.map((score, i) => ({
    score: score[0],
    value: values[i].value,
  }));
  render(filterTable(filterData), $filters);
}

$filters.addEventListener("input", (e) => {
  const $minSimilarity = e.target.closest(".min-similarity");
  if ($minSimilarity) render(filterTable(filterData), $filters);
});

function getFilter($el) {
  const { table, column } = $el.closest("tr[data-table][data-column]")?.dataset;
  if (!table || !column) return;
  return filterData.filters.find(
    ({ table: ftable, column: fcolumn }) =>
      ftable == table && fcolumn == column,
  );
}

$filters.addEventListener("change", async (e) => {
  const $filterValue = e.target.closest(".filter-value");
  if ($filterValue) {
    const filter = getFilter($filterValue);
    filter.value = $filterValue.value;
    await matchFilter(filter);
  }
  const $filterEnabled = e.target.closest(".filter-enabled");
  if ($filterEnabled) {
    const filter = getFilter($filterEnabled);
    filter.disabled = !$filterEnabled.checked;
    render(filterTable(filterData), $filters);
  }
});

$filters.addEventListener("submit", async (e) => {
  const $updateFilterForm = e.target.closest("#update-filter-form");
  if ($updateFilterForm) {
    e.preventDefault();
    const data = new FormData($updateFilterForm);
    const newMessages = [
      {
        role: "assistant",
        content: filterData.filters
          .filter(({ disabled }) => !disabled)
          .map(
            (filter) => `
- requirement: ${filter.requirement}
- table: ${filter.table}
- column: ${filter.column}
- operator: ${filter.operator}
- value: ${filter.value}
`,
          )
          .join("\n"),
      },
      {
        role: "user",
        content: `Update the filters: ${$filters.querySelector("#update-filter").value}`,
      },
    ];
    await renderFilterTable([...messages, ...newMessages]);
  }
});

$filters.addEventListener("click", async (e) => {
  const $applyFilters = e.target.closest("#apply-filters");
  if ($applyFilters) {
    // Collect the filters
    const tables = {};
    for (const filter of filterData.filters) {
      if (filter.disabled) continue;
      tables[filter.table] = tables[filter.table] ?? { where: [], params: [] };
      const { where, params } = tables[filter.table];
      if (filter.matches) {
        const values = filter.matches
          .filter(({ score }) => score >= filter.minSimilarity)
          .map(({ value }) => value);
        if (values.length === 0) continue;
        where.push(`${filter.column} IN (${values.map(() => "?").join(",")})`);
        params.push(...values);
      } else {
        where.push(`${filter.column} ${filter.operator} ?`);
        // Convert numeric strings to numbers for comparison operators
        const value = ["<", "<=", ">", ">="].includes(filter.operator)
          ? Number(filter.value)
          : filter.value;
        params.push(value);
      }
    }

    const results = [];
    const keys = [];
    const mainField = $mainField.value;
    for (const [table, { where, params }] of Object.entries(tables)) {
      const sql =
        where.length > 0
          ? `SELECT * FROM ${table} WHERE ${where.join(" AND ")}`
          : `SELECT * FROM ${table}`;
      try {
        tables[table].result = await db.exec(sql, {
          bind: params,
          rowMode: "object",
        });
        results.push(drawTable(table, tables[table].result));
        keys.push(new Set(tables[table].result.map((row) => row[mainField])));
      } catch (e) {
        results.push(html`<div class="alert alert-danger">${e.message}</div>`);
      }
    }

    const commonKeys =
      keys.length > 0
        ? keys
            .filter((k) => k.size > 1)
            .reduce((a, b) => new Set([...a].filter((x) => b.has(x))))
        : new Set();
    results.push(
      html` <details>
        <summary class="alert alert-primary">
          <strong>Common ${mainField}</strong>:
          ${commonKeys.size > 100 ? "100+" : commonKeys.size} results
        </summary>
        <div class="list-group">
          ${[...commonKeys].slice(0, 100).map(
            (key) =>
              html`<a href="#" class="list-group-item list-group-item-action"
                >${key}</a
              >`,
          )}
        </div>
      </details>`,
    );

    render(results, $results);
  }
});

const drawTable = (name, table) => {
  const columns = table.length ? Object.keys(table[0]) : [];
  return html`
    <details>
      <summary class="alert alert-primary">
        <strong>${name}</strong>: ${table.length > 100 ? "100+" : table.length}
        results
      </summary>
      <div class="table-responsive">
        <table class="table table-sm table-striped">
          <thead>
            <tr>
              ${columns.map((col) => html`<th>${col}</th>`)}
            </tr>
          </thead>
          <tbody>
            ${table.slice(0, 100).map(
              (row) =>
                html`<tr>
                  ${columns.map((col) => html`<td>${row[col]}</td>`)}
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
    </details>
  `;
};

// --------------------------------------------------------------------
// Automatically identify the type of metadata
function prepareMetadata() {
  metadata = {
    table: db.exec("SELECT * FROM metadata", { rowMode: "object" }),
  };
  if (!metadata.table.length) return;
  for (const row of metadata.table) {
    row.type =
      row.type == "object" ? "str" : row.type == "float64" ? "float" : row.type;
  }
}

// --------------------------------------------------------------------
async function autoload() {
  notify(
    "info",
    "Loading",
    /* html */ `Loading default datasets <div class='spinner-border spinner-border-sm'></div>`,
  );

  try {
    // Fetch the SQLite database
    const dbResponse = await fetch("data.db");
    const dbBlob = await dbResponse.blob();
    const dbFile = new File([dbBlob], "data.db");

    // Fetch the CSV file
    const csvResponse = await fetch("metadata.csv?x=1");
    const csvBlob = await csvResponse.blob();
    const csvFile = new File([csvBlob], "metadata.csv");

    // Upload both files using existing DB methods
    await Promise.all([DB.upload(dbFile), DB.upload(csvFile)]);

    notify("success", "Loaded", "Default datasets imported successfully");

    prepareMetadata();
    drawTables();
  } catch (error) {
    console.error(error);
    notify("danger", "Error", "Failed to load default datasets");
  }
}

// autoload();
