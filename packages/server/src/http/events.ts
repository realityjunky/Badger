import { setTimeout } from "node:timers/promises";
import { canonicalHash } from "@realityjunky/badger";
import { accessFor, visibleGroups } from "../authorization.js";
import type { Principal } from "../identity/identity.js";
import { inboxFingerprint } from "../inbox.js";
import type { AuthorizedRequest } from "./authorized-request.js";

/**
 * Database snapshots make the stream work across server/worker processes.
 * Events are invalidations, carrying no question or answer content. Every
 * connection starts with a fresh snapshot, including after a missed event;
 * replay of a transient event log is therefore unnecessary.
 */
export async function handleEvents(
  input: AuthorizedRequest,
  principal: Principal,
  stopping: AbortSignal,
  reidentify: () => Promise<boolean>,
) {
  const { database, person, config, reply, method } = input;
  if (method === "HEAD")
    return reply.send({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: "",
    });
  const snapshot = async () => {
    const access = await accessFor(database, person, principal, config);
    const visibility = await visibleGroups(database, access, person);
    const versions = await database.query<{
      id: string;
      revision: number;
      questionnaire_revision: number;
      settings_revision: number;
    }>(
      `select v.id, v.revision, coalesce(q.revision, 0) as questionnaire_revision, coalesce(s.revision, 0) as settings_revision
      from workflow_versions v join workflows w on w.id = v.workflow_id
      left join questionnaires q on q.workflow_version_id = v.id
      left join questionnaire_settings s on s.workflow_id = w.id
      where $2::boolean or w.group_id = any($3::text[]) or exists
        (select 1 from role_bindings b where b.workflow_id = w.id and b.person_id = $1) order by v.id`,
      [
        person.id,
        visibility.everything,
        visibility.everything ? [] : [...visibility.groupIds],
      ],
    );
    return {
      versions: versions.rows,
      inbox: await inboxFingerprint(database, access, person),
    };
  };
  let previous = await snapshot();
  const stream = reply.eventStream();
  const signal = AbortSignal.any([stream.signal, stopping]);
  const close = () => stream.close();
  stopping.addEventListener("abort", close, { once: true });
  try {
    stream.send("ready", {
      versionIds: previous.versions.map((v) => v.id),
      inbox: true,
    });
    for (let tick = 1; tick <= 30 && !signal.aborted; tick++) {
      await setTimeout(1000, undefined, { signal });
      // Sessions are revalidated during a connection as well as on each
      // reconnect; current Badger roles are re-read on every snapshot.
      if (tick % 15 === 0 && !(await reidentify())) break;
      const current = await snapshot();
      if (canonicalHash(current) !== canonicalHash(previous)) {
        const old = new Map(
          previous.versions.map((v) => [v.id, canonicalHash(v)]),
        );
        const versionIds = current.versions
          .filter((v) => old.get(v.id) !== canonicalHash(v))
          .map((v) => v.id);
        for (const removed of previous.versions)
          if (!current.versions.some((v) => v.id === removed.id))
            versionIds.push(removed.id);
        stream.send("change", {
          versionIds,
          inbox: canonicalHash(current.inbox) !== canonicalHash(previous.inbox),
        });
        previous = current;
      } else if (tick % 10 === 0) stream.send("heartbeat", {});
    }
  } catch {
    // An aborted client, lost database, or failed provider ends this stream.
    // EventSource reconnects; the dashboard also keeps its polling fallback.
  } finally {
    stopping.removeEventListener("abort", close);
    stream.close();
  }
}
