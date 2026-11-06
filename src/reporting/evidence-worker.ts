import type { Artifact, OutboxEvent } from '@prisma/client';
import { hasJobAuthority } from '../jobs/authority';
import { TerminalJobError, type Handler } from '../jobs/runner';
import type { ObjectStorage } from '../platform/storage';
import { audit, digest, jsonDigest, setContext } from '../platform/transaction';
import { getArtifact } from './evidence';
import { renderEvidencePdf } from './pdf';
import { readinessSchema } from './readiness';

const active = (row: Artifact, event: OutboxEvent) => row.state === 'QUEUED' && row.version === event.targetVersion;
type Prepared = { key: string; digest: string; bytes: number };

export function evidenceHandlers(storage: ObjectStorage): Record<string, Handler> {
  return {
    EVIDENCE_RENDER: {
      async prepare(event, database) {
        const artifact = await database.$transaction(async (tx) => {
          await setContext(tx, event.actorId, event.tenantId);
          const current = await getArtifact(tx, event.tenantId, event.targetId);
          if (!active(current, event)) return null;
          if (!await hasJobAuthority(tx, event, false)) throw new TerminalJobError('EVIDENCE_PERMISSION_REVOKED');
          return current;
        });
        if (!artifact) return null;
        const verified = readinessSchema.safeParse(artifact.snapshot.inputs);
        if (!verified.success || jsonDigest(verified.data) !== artifact.snapshot.checksum) {
          throw new TerminalJobError('EVIDENCE_SNAPSHOT_INVALID');
        }
        const pdf = await renderEvidencePdf(artifact.id, artifact.snapshot.checksum, verified.data);
        const checksum = digest(pdf);
        const key = `tenants/${event.tenantId}/evidence/${artifact.id}/${checksum}.pdf`;
        await storage.put(key, pdf, 'application/pdf');
        return { key, digest: checksum, bytes: pdf.length };
      },
      async apply(event, tx, prepared) {
        const current = await getArtifact(tx, event.tenantId, event.targetId, true);
        if (!active(current, event) || !prepared) return;
        if (!await hasJobAuthority(tx, event, true)) throw new TerminalJobError('EVIDENCE_PERMISSION_REVOKED');
        const file = prepared as Prepared;
        const updated = await tx.artifact.update({
          where: { tenantId_id: { tenantId: event.tenantId, id: current.id } },
          data: {
            state: 'READY', objectKey: file.key, digest: file.digest, bytes: file.bytes,
            expiresAt: new Date(Date.now() + 86_400_000), version: { increment: 1 },
          },
        });
        await audit(tx, event.tenantId, event.actorId, event.requestId, 'evidence_ready', current.id, updated.version);
      },
      async fail(event, tx, code) {
        const current = await getArtifact(tx, event.tenantId, event.targetId, true);
        if (!active(current, event)) return;
        await tx.artifact.update({
          where: { tenantId_id: { tenantId: event.tenantId, id: current.id } },
          data: { state: 'FAILED', problemCode: code, version: { increment: 1 } },
        });
      },
    },
  };
}
