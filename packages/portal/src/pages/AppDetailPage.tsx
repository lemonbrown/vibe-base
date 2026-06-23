import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Member, PlatformRole } from "@vibe/shared";
import {
  useAppStatus,
  useDeployments,
  useDeleteApp,
  useInvite,
  useLogs,
  useMembers,
  useRevoke,
  useRollback,
} from "../lib/queries";
import { Card, ConfirmButton, HealthBadge, StatusPill } from "../components/ui";
import { InlineError, LoadingBlock, Spinner } from "../components/States";
import { relativeTime } from "../lib/format";

/* ------------------------------- overview ------------------------------- */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <span className="text-[var(--color-muted)]">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function Overview({ id }: { id: string }) {
  const { data: status, isLoading, error } = useAppStatus(id);
  const rollback = useRollback(id);

  if (isLoading) return <LoadingBlock />;
  if (error) return <InlineError message={(error as Error).message} />;
  if (!status) return null;

  const { app, manifestSummary: ms, database, storage } = status;
  const cap = (on: boolean, provisioned: boolean) =>
    !on ? "off" : provisioned ? "provisioned" : "enabled";

  return (
    <Card>
      <div className="divide-y divide-[var(--color-border)]">
        <Row label="Status">
          <StatusPill status={app.status} />
        </Row>
        <Row label="URL">
          {app.url ? (
            <a href={app.url} target="_blank" rel="noreferrer" className="text-[var(--color-brand)]">
              {app.url}
            </a>
          ) : (
            <span className="text-[var(--color-muted)]">not deployed</span>
          )}
        </Row>
        <Row label="Runtime">
          {ms.runtimeAdapter} · port {ms.port}
        </Row>
        <Row label="Database">{cap(database.enabled, database.provisioned)}</Row>
        <Row label="Storage">{cap(storage.enabled, storage.provisioned)}</Row>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {app.url && (
          <a href={app.url} target="_blank" rel="noreferrer" className="btn-ghost">
            Open app ↗
          </a>
        )}
        <ConfirmButton
          variant="ghost"
          confirmLabel="Roll back?"
          onConfirm={() => rollback.mutate()}
          disabled={rollback.isPending}
        >
          {rollback.isPending ? "Rolling back…" : "Roll back"}
        </ConfirmButton>
      </div>
      {rollback.error && (
        <p className="mt-2 text-sm text-[var(--color-bad)]">{(rollback.error as Error).message}</p>
      )}
    </Card>
  );
}

/* -------------------------------- members ------------------------------- */

function MemberRow({ m, id }: { m: Member; id: string }) {
  const revoke = useRevoke(id);
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <div className="min-w-0">
        <p className="truncate">{m.email}</p>
        <p className="text-xs text-[var(--color-faint)]">
          {m.role} · {m.status}
        </p>
      </div>
      {m.role !== "owner" && m.status !== "revoked" && (
        <ConfirmButton confirmLabel="Revoke?" onConfirm={() => revoke.mutate(m.email)}>
          Revoke
        </ConfirmButton>
      )}
    </div>
  );
}

function Members({ id }: { id: string }) {
  const { data: members, isLoading } = useMembers(id);
  const invite = useInvite(id);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<PlatformRole>("member");

  return (
    <Card title="Members">
      {isLoading ? (
        <LoadingBlock />
      ) : (
        <div className="divide-y divide-[var(--color-border)]">
          {members && members.length > 0 ? (
            members.map((m) => <MemberRow key={m.email} m={m} id={id} />)
          ) : (
            <p className="py-2 text-sm text-[var(--color-muted)]">Just you.</p>
          )}
        </div>
      )}

      <form
        className="mt-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!email.trim()) return;
          invite.mutate(
            { email: email.trim(), role },
            { onSuccess: () => setEmail("") }
          );
        }}
      >
        <input
          className="input sm:flex-1"
          type="email"
          placeholder="email to invite"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <select
          className="input sm:w-32"
          value={role}
          onChange={(e) => setRole(e.target.value as PlatformRole)}
        >
          <option value="member">member</option>
          <option value="leader">leader</option>
        </select>
        <button className="btn-primary" disabled={invite.isPending}>
          {invite.isPending ? "Inviting…" : "Invite"}
        </button>
      </form>

      {invite.error && (
        <p className="mt-2 text-sm text-[var(--color-bad)]">{(invite.error as Error).message}</p>
      )}
      {invite.data && <ClaimLink url={invite.data.claimUrl} />}
    </Card>
  );
}

function ClaimLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-3">
      <p className="mb-1 text-xs text-[var(--color-muted)]">
        Share this claim link with the invited user:
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-brand)]">
          {url}
        </code>
        <button
          type="button"
          className="btn-ghost px-2.5 py-1 text-xs"
          onClick={() => {
            navigator.clipboard?.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------ deployments ----------------------------- */

function Deployments({ id }: { id: string }) {
  const { data: deps, isLoading } = useDeployments(id);
  return (
    <Card title="Recent deployments">
      {isLoading ? (
        <LoadingBlock />
      ) : deps && deps.length > 0 ? (
        <div className="divide-y divide-[var(--color-border)]">
          {deps.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="font-mono text-xs text-[var(--color-faint)]">{d.id}</p>
                <p className="text-xs text-[var(--color-muted)]">
                  {relativeTime(d.createdAt)} · {d.source}
                  {d.gitSha ? ` · ${d.gitSha.slice(0, 7)}` : ""}
                </p>
              </div>
              <StatusPill status={d.status} />
            </div>
          ))}
        </div>
      ) : (
        <p className="py-2 text-sm text-[var(--color-muted)]">No deployments yet.</p>
      )}
    </Card>
  );
}

/* --------------------------------- logs --------------------------------- */

function Logs({ id }: { id: string }) {
  const [build, setBuild] = useState(false);
  const { data: log, isFetching, refetch } = useLogs(id, build);
  return (
    <Card
      title="Logs"
      action={
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-[var(--color-border-strong)] p-0.5 text-xs">
            {[
              { v: false, label: "Runtime" },
              { v: true, label: "Build" },
            ].map((t) => (
              <button
                key={t.label}
                type="button"
                onClick={() => setBuild(t.v)}
                className={
                  build === t.v
                    ? "rounded-md bg-[var(--color-brand-soft)] px-2 py-1 text-[var(--color-text)]"
                    : "px-2 py-1 text-[var(--color-muted)]"
                }
              >
                {t.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn-ghost px-2.5 py-1 text-xs"
            onClick={() => refetch()}
          >
            {isFetching ? <Spinner /> : "Refresh"}
          </button>
        </div>
      }
    >
      <pre className="max-h-80 overflow-auto rounded-lg bg-black/40 p-3 font-mono text-xs leading-relaxed text-[var(--color-text)]">
        {log?.trim() ? log : "(no logs)"}
      </pre>
    </Card>
  );
}

/* ------------------------------ danger zone ----------------------------- */

function DangerZone({ id, name }: { id: string; name: string }) {
  const del = useDeleteApp(id);
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState("");

  return (
    <Card className="border-[#5a2730]">
      <h2 className="section-title mb-2 text-[var(--color-bad)]">Danger zone</h2>
      <p className="mb-3 text-sm text-[var(--color-muted)]">
        Permanently delete this app — its container, database, storage bucket,
        routing, and all records. This cannot be undone. Your GitHub repo is left
        untouched.
      </p>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (confirm !== id) return;
          del.mutate(undefined, { onSuccess: () => navigate("/") });
        }}
      >
        <input
          className="input sm:flex-1"
          placeholder={`type ${id} to confirm`}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <button className="btn-danger" disabled={confirm !== id || del.isPending}>
          {del.isPending ? "Deleting…" : `Delete ${name}`}
        </button>
      </form>
      {del.error && (
        <p className="mt-2 text-sm text-[var(--color-bad)]">{(del.error as Error).message}</p>
      )}
    </Card>
  );
}

/* --------------------------------- page --------------------------------- */

export function AppDetailPage() {
  const { id = "" } = useParams();
  const { data: status } = useAppStatus(id);
  const app = status?.app;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link to="/" className="text-sm text-[var(--color-muted)] hover:text-[var(--color-text)]">
          ← All apps
        </Link>
      </div>
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{app?.name ?? id}</h1>
        {app && <HealthBadge health={app.health} />}
      </div>

      <Overview id={id} />
      <Members id={id} />
      <Deployments id={id} />
      <Logs id={id} />
      <DangerZone id={id} name={app?.name ?? id} />
    </div>
  );
}
