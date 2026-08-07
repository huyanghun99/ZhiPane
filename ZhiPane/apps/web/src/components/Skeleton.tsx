/**
 * Reusable skeleton primitives (Phase 3 unified loading state).
 *
 * A single shimmer animation (defined in styles.css) is shared by every
 * loading placeholder so async surfaces feel consistent instead of each
 * feature inventing its own spinner.
 */
export function SkeletonLine({ width }: { width?: string | number }) {
  return <div className="skeleton skel-line-el" style={{ width }} />;
}

export function SkeletonBlock({ height = 60 }: { height?: number }) {
  return <div className="skeleton skel-block" style={{ height }} />;
}

export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <div className="skel-list">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="skel-row" key={i}>
          <SkeletonLine width={`${60 + ((i * 13) % 30)}%`} />
          <SkeletonLine width="40%" />
        </div>
      ))}
    </div>
  );
}

export function EditorSkeleton() {
  return (
    <div className="editor-loading-skeleton">
      <div className="skel-head">
        <SkeletonLine width="45%" />
        <SkeletonLine width="30%" />
      </div>
      <div className="skel-body">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonLine key={i} width={i === 0 ? '60%' : undefined} />
        ))}
      </div>
    </div>
  );
}
