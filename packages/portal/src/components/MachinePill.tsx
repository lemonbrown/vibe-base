import type { MachineStatus } from "../lib/api";

/** Shows whether the owner's `vibe agent` daemon is reachable. The chat relays
 *  to that machine, so this is the single most important signal on the page. */
export function MachinePill({
  machine,
  loading,
}: {
  machine: MachineStatus | null | undefined;
  loading?: boolean;
}) {
  if (loading) {
    return <span className="pill text-[var(--color-muted)]">checking machine…</span>;
  }
  if (!machine) {
    return (
      <span className="pill text-[var(--color-warn)]" title="Run `vibe agent` on your machine">
        <Dot color="var(--color-warn)" /> no machine registered
      </span>
    );
  }
  const color = machine.online ? "var(--color-ok)" : "var(--color-bad)";
  return (
    <span className="pill" style={{ color }} title={machine.name}>
      <Dot color={color} pulse={machine.online} />
      {machine.name} · {machine.online ? "online" : "offline"}
    </span>
  );
}

function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span className="relative flex h-1.5 w-1.5">
      {pulse && (
        <span
          className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
          style={{ background: color }}
        />
      )}
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: color }} />
    </span>
  );
}
