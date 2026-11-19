/** Placeholder de carregamento com o mesmo formato dos itens reais. */
export function ParticipantsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="space-y-2" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <li
          key={index}
          className="flex items-center gap-3 rounded-xl border border-white/[0.05] bg-white/[0.02] px-3 py-2.5"
        >
          <span className="size-10 shrink-0 rounded-full bg-white/[0.06] motion-safe:animate-pulse" />
          <span className="flex-1 space-y-2">
            <span className="block h-3 w-1/3 rounded bg-white/[0.07] motion-safe:animate-pulse" />
            <span className="block h-2.5 w-1/4 rounded bg-white/[0.05] motion-safe:animate-pulse" />
          </span>
        </li>
      ))}
    </ul>
  );
}
