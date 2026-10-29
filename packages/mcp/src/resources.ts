import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CallToolResult,
  Resource,
} from "@modelcontextprotocol/sdk/types.js";

const MAX_INLINE_BYTES = 8192;
const MAX_STORED_BYTES = 16 * 1024 * 1024;
const MAX_RESOURCES = 32;

/** Bounded, connection-local results; each read checks current service access. */
export class ResultResources {
  private readonly entries = new Map<
    string,
    {
      resource: Resource;
      bytes: number;
      localFile: string;
      read: () => Promise<unknown>;
    }
  >();
  private bytes = 0;
  private directory: string | null = null;
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;

  async result(
    value: unknown,
    read: () => Promise<unknown>,
  ): Promise<CallToolResult> {
    if (this.closed) throw new Error("The MCP connection is closed");
    const text = JSON.stringify(value);
    const bytes = Buffer.byteLength(text);
    const inline: CallToolResult = { content: [{ type: "text", text }] };
    if (Buffer.byteLength(JSON.stringify(inline)) <= MAX_INLINE_BYTES)
      return inline;
    if (bytes > MAX_STORED_BYTES)
      throw new Error(
        "Result is too large; select one workflow version or a smaller inbox page",
      );
    // Concurrent tool calls share one retention budget and one private folder.
    const writing = this.pending.then(() => this.store(text, bytes, read));
    this.pending = writing.then(
      () => undefined,
      () => undefined,
    );
    return writing;
  }

  private async store(
    text: string,
    bytes: number,
    read: () => Promise<unknown>,
  ): Promise<CallToolResult> {
    if (this.closed) throw new Error("The MCP connection is closed");
    while (
      this.entries.size >= MAX_RESOURCES ||
      this.bytes + bytes > MAX_STORED_BYTES
    ) {
      const oldest = this.entries.keys().next().value!;
      const entry = this.entries.get(oldest)!;
      await fs.rm(entry.localFile, { force: true });
      this.bytes -= entry.bytes;
      this.entries.delete(oldest);
    }
    if (this.directory === null) {
      this.directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "badger-mcp-results-"),
      );
      await fs.chmod(this.directory, 0o700);
    }
    const resultId = randomUUID();
    const localFile = path.join(this.directory, `${resultId}.json`);
    try {
      await fs.writeFile(localFile, text, { mode: 0o600, flag: "wx" });
    } catch (error) {
      await fs.rm(localFile, { force: true });
      throw error;
    }
    const resource: Resource = {
      uri: `badger://results/${resultId}`,
      name: "Badger result",
      mimeType: "application/json",
      description:
        "Read the full result with resources/read. Access is checked again on each read.",
    };
    this.entries.set(resource.uri, { resource, bytes, localFile, read });
    this.bytes += bytes;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            localFile,
            bytes,
            mimeType: "application/json",
            message:
              "Read this private local file with the host's file tools, or read the linked MCP resource. The file lasts for this connection.",
          }),
        },
        { type: "resource_link", ...resource },
      ],
    };
  }

  list(): Resource[] {
    return [...this.entries.values()].map((entry) => entry.resource);
  }

  async read(uri: string) {
    const entry = this.entries.get(uri);
    if (!entry) throw new Error("No such result resource; call the tool again");
    const text = JSON.stringify(await entry.read());
    if (Buffer.byteLength(text) > MAX_STORED_BYTES)
      throw new Error("Result is too large; narrow the request");
    return { contents: [{ uri, mimeType: "application/json", text }] };
  }

  close(): Promise<void> {
    this.closed = true;
    this.closing ??= this.removeFiles();
    return this.closing;
  }

  private async removeFiles() {
    await this.pending;
    this.entries.clear();
    this.bytes = 0;
    if (this.directory)
      await fs.rm(this.directory, { recursive: true, force: true });
  }
}
