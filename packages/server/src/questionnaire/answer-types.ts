import { RequestError, objectInput } from "../http/errors.js";

export type AnswerType =
  | { kind: "free-text" | "yes-no" | "file" }
  | { kind: "single-choice" | "multiple-choice"; options: string[] }
  | { kind: "number"; unit: string }
  | { kind: "table"; columns: string[] };
export type AnswerValue =
  string | string[] | boolean | number | string[][] | null;
export interface AnswerAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  hash: string;
}

function invalid(message: string): never {
  throw new RequestError(400, message);
}
export function parseAnswerType(value: unknown): AnswerType {
  if (value === undefined) return { kind: "free-text" };
  const input = objectInput(value);
  const kind = input.kind;
  const parameter =
    kind === "single-choice" || kind === "multiple-choice"
      ? "options"
      : kind === "table"
        ? "columns"
        : kind === "number"
          ? "unit"
          : null;
  if (Object.keys(input).some((key) => key !== "kind" && key !== parameter))
    invalid("Unknown answer type setting");
  if (kind === "free-text" || kind === "yes-no" || kind === "file")
    return { kind };
  if (kind === "number") {
    if (
      typeof input.unit !== "string" ||
      !input.unit.trim() ||
      input.unit.length > 100
    )
      invalid("A number question needs a unit of at most 100 characters");
    return { kind, unit: input.unit };
  }
  if (
    kind === "single-choice" ||
    kind === "multiple-choice" ||
    kind === "table"
  ) {
    const items = input[parameter!];
    const minimum = kind === "table" ? 1 : 2;
    const maximum = kind === "table" ? 20 : 100;
    if (
      !Array.isArray(items) ||
      items.length < minimum ||
      items.length > maximum ||
      items.some(
        (item) => typeof item !== "string" || !item.trim() || item.length > 200,
      ) ||
      new Set(items.map((item) => (item as string).trim())).size !==
        items.length
    )
      invalid(
        `Provide ${minimum} to ${maximum} distinct, nonempty ${parameter}`,
      );
    return kind === "table"
      ? { kind, columns: items as string[] }
      : { kind, options: items as string[] };
  }
  return invalid("Choose a supported answer type");
}

/** Incomplete drafts are allowed; submitted answers must satisfy the question. */
export function validateAnswerValue(
  type: AnswerType,
  input: unknown,
  text: unknown,
  attachments: AnswerAttachment[],
  submitted: boolean,
): { value: AnswerValue; text: string } {
  const value = input ?? null;
  if (type.kind === "free-text") {
    if (input !== undefined && input !== null)
      invalid("Free-text answers use text");
    if (
      typeof text !== "string" ||
      text.length > 50000 ||
      (submitted && !text.trim())
    )
      invalid("Provide answer text of at most 50000 characters");
    return { value: null, text };
  }
  if (text !== undefined && text !== "")
    invalid("Structured answers use value");
  if (value === null && !submitted) return { value: null, text: "" };
  switch (type.kind) {
    case "single-choice":
      if (typeof value !== "string" || !type.options.includes(value))
        invalid("Choose one of the question's options");
      return { value, text: value };
    case "multiple-choice":
      if (
        !Array.isArray(value) ||
        value.some(
          (item) => typeof item !== "string" || !type.options.includes(item),
        ) ||
        new Set(value).size !== value.length ||
        (submitted && value.length === 0)
      )
        invalid("Choose distinct options from the question");
      return { value: value as string[], text: value.join(", ") };
    case "yes-no":
      if (typeof value !== "boolean") invalid("Answer yes or no");
      return { value, text: value ? "Yes" : "No" };
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        invalid("Provide a finite number in the question's unit");
      return { value, text: `${value} ${type.unit}` };
    case "table":
      if (
        !Array.isArray(value) ||
        value.length > 100 ||
        (submitted && value.length === 0) ||
        value.some(
          (row) =>
            !Array.isArray(row) ||
            row.length !== type.columns.length ||
            row.some(
              (cell) =>
                typeof cell !== "string" ||
                cell.length > 4000 ||
                (submitted && !cell.trim()),
            ),
        ) ||
        JSON.stringify(value).length > 50000
      )
        invalid(
          "Provide up to 100 rows matching the question's columns, with nonempty cells before submitting",
        );
      return {
        value: value as string[][],
        text: [type.columns, ...(value as string[][])]
          .map((row) => row.join(" | "))
          .join("\n"),
      };
    case "file":
      if (value !== null || (submitted && attachments.length === 0))
        invalid("A file answer needs an attachment");
      return {
        value: null,
        text: attachments.map((file) => file.name).join(", "),
      };
  }
}
