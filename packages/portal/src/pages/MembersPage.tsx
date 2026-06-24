import { useState } from "react";
import { usePortalMembers, usePortalInvite, useRevokePortalMember } from "../lib/queries";
import { InlineError, LoadingBlock } from "../components/States";
import { ConfirmButton } from "../components/ui";
import { relativeTime } from "../lib/format";

const STATUS_COLOR: Record<string, string> = {
  active: "var(--color-ok)",
  invited: "var(--color-warn)",
  revoked: "var(--color-bad)",
};

export function MembersPage() {
  const { data, isLoading, error } = usePortalMembers();
  const invite = usePortalInvite();
  const revoke = useRevokePortalMember();
  const [email, setEmail] = useState("");
  const [lastInvite, setLastInvite] = useState<{ email: string; sent: boolean; claimUrl?: string } | null>(null);

  const members = data?.members ?? [];
  const emailConfigured = data?.emailConfigured ?? false;

  function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    invite.mutate(trimmed, {
      onSuccess: (result) => {
        setLastInvite(result);
        setEmail("");
      },
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Members</h1>
        {members.length > 0 && (
          <span className="text-sm text-[var(--color-muted)]">
            {members.length} {members.length === 1 ? "member" : "members"}
          </span>
        )}
      </div>

      {!emailConfigured && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-sm text-[var(--color-muted)]">
          Email is not configured — invite links will be shown so you can share them manually.
          Set <code className="rounded bg-[var(--color-bg)] px-1 py-0.5 font-mono text-xs">RESEND_API_KEY</code> or{" "}
          <code className="rounded bg-[var(--color-bg)] px-1 py-0.5 font-mono text-xs">GMAIL_*</code> to send automatically.
        </div>
      )}

      {/* Invite form */}
      <section className="card p-4">
        <h2 className="section-title mb-3">Invite someone</h2>
        <form onSubmit={handleInvite} className="flex gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="colleague@example.com"
            required
            className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
          />
          <button
            type="submit"
            disabled={invite.isPending || !email.trim()}
            className="btn-primary shrink-0 disabled:opacity-50"
          >
            {invite.isPending ? "Sending…" : "Invite"}
          </button>
        </form>

        {invite.isError && (
          <InlineError message={(invite.error as Error).message} />
        )}

        {lastInvite && (
          <div className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-sm">
            {lastInvite.sent ? (
              <span className="text-[var(--color-ok)]">
                Invite sent to {lastInvite.email}.
              </span>
            ) : (
              <div className="flex flex-col gap-2">
                <span className="text-[var(--color-muted)]">
                  Share this link with {lastInvite.email}:
                </span>
                <code
                  className="break-all rounded bg-[var(--color-bg)] px-2 py-1.5 font-mono text-xs text-[var(--color-brand)] cursor-pointer select-all"
                  onClick={() => lastInvite.claimUrl && navigator.clipboard.writeText(lastInvite.claimUrl)}
                  title="Click to copy"
                >
                  {lastInvite.claimUrl}
                </code>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Member list */}
      {isLoading && <LoadingBlock label="Loading members…" />}
      {error && <InlineError message={(error as Error).message} />}

      {!isLoading && members.length > 0 && (
        <section className="card divide-y divide-[var(--color-border)] overflow-hidden p-0">
          {members.map((m) => (
            <div key={m.email} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: STATUS_COLOR[m.status] ?? STATUS_COLOR.invited }}
                  aria-hidden
                />
                <span className="truncate text-sm">{m.email}</span>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs text-[var(--color-muted)]">
                  {m.status === "invited"
                    ? m.invitedAt ? `invited ${relativeTime(m.invitedAt)}` : "invited"
                    : m.status === "active"
                    ? m.joinedAt ? `joined ${relativeTime(m.joinedAt)}` : "active"
                    : "revoked"}
                </span>
                {m.status !== "revoked" && (
                  <ConfirmButton
                    variant="ghost"
                    confirmLabel="Sure?"
                    onConfirm={() => revoke.mutate(m.email)}
                    disabled={revoke.isPending}
                  >
                    Revoke
                  </ConfirmButton>
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      {!isLoading && !error && members.length === 0 && (
        <p className="text-sm text-[var(--color-muted)]">No members yet. Invite someone above.</p>
      )}
    </div>
  );
}
