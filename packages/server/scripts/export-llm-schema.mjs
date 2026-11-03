import { writeFile } from "node:fs/promises";
import { format } from "prettier";
import { LLM_CONFIGURATION_SCHEMA } from "../dist/src/llm/configuration.js";

// The runtime validator is authoritative; never maintain a second schema by hand.
const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Badger LLM configuration file v1",
  type: "object",
  additionalProperties: false,
  required: ["revision", "configuration"],
  properties: {
    revision: { type: "integer", minimum: 0 },
    configuration: LLM_CONFIGURATION_SCHEMA,
  },
};
await writeFile(
  new URL("../config/llm.schema.json", import.meta.url),
  await format(JSON.stringify(schema), { parser: "json" }),
);
