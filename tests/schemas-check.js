// Compiles every JSON Schema in ../schemas under Ajv strict mode (draft 2020-12).
//
// Catches malformed schemas, unresolved $refs, unknown keywords, and
// strict-mode type/required inconsistencies before they reach implementers.
// Run `node schemas-check.js` from the tests/ directory.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const DIR = path.join(__dirname, "..", "schemas");

// strictRequired is off: `not: { required: [x] }` (field-must-be-absent) is a
// valid idiom core.json uses, but Ajv flags it.
// "version" is a PhIP annotation on every schema, not a JSON Schema keyword.
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, strictRequired: false, allErrors: true });
ajv.addKeyword("version");
addFormats(ajv);

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
const schemas = [];
let fail = 0;

for (const f of files) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    const expectedId = `https://github.com/mfgs-us/phip/schemas/${f}`;
    if (s.$id !== expectedId) throw new Error(`$id is ${s.$id}, expected ${expectedId}`);
    ajv.addSchema(s);
    schemas.push([f, s.$id]);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${f}: ${e.message}`);
  }
}

for (const [f, id] of schemas) {
  try {
    ajv.getSchema(id);
    console.log(`  ok  ${f}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${f}: ${e.message}`);
  }
}

console.log(`\n${files.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
