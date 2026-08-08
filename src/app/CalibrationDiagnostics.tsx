import { useMemo } from "preact/hooks";
import {
  HEALTH_GRID_COLUMNS,
  HEALTH_GRID_ROWS,
  calibrationHealth,
} from "../domain/calibration-health";
import type {
  CalibrationResultV1,
  FrameObservation,
  PointResidual,
} from "../domain/types";
import { ObservationThumbnail } from "./ObservationThumbnail";

function DiagnosticHeatmap({
  label,
  values,
  counts,
  valueLabel,
}: {
  label: string;
  values: number[];
  counts?: number[];
  valueLabel: (value: number, count: number) => string;
}) {
  const maximum = Math.max(0, ...values);
  return (
    <div class="diagnostic-map">
      <h3>{label}</h3>
      <div
        class="heatmap"
        role="img"
        aria-label={label}
        style={{
          gridTemplateColumns: `repeat(${HEALTH_GRID_COLUMNS}, 1fr)`,
          gridTemplateRows: `repeat(${HEALTH_GRID_ROWS}, 1fr)`,
        }}
      >
        {values.map((value, index) => {
          const count = counts?.[index] ?? value;
          const intensity = maximum > 0 ? value / maximum : 0;
          return (
            <span
              key={index}
              class={count > 0 ? "heat-cell observed" : "heat-cell"}
              title={valueLabel(value, count)}
              style={{ opacity: count > 0 ? 0.3 + intensity * 0.7 : 1 }}
            />
          );
        })}
      </div>
    </div>
  );
}

function ResidualViewCard({
  observation,
  residuals,
  error,
  index,
}: {
  observation: FrameObservation;
  residuals: PointResidual[];
  error: number;
  index: number;
}) {
  const vectorScale = 20;
  const stride = Math.max(1, Math.ceil(residuals.length / 180));
  const visibleResiduals = residuals.filter((_, residualIndex) => residualIndex % stride === 0);
  return (
    <article class="observation-card residual-card">
      <div
        class="observation-image residual-image"
        style={{ aspectRatio: `${observation.imageSize.width} / ${observation.imageSize.height}` }}
      >
        <ObservationThumbnail observation={observation} />
        <svg
          viewBox={`0 0 ${observation.imageSize.width} ${observation.imageSize.height}`}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        >
          {visibleResiduals.map((residual) => {
            const endX =
              residual.observed.x +
              (residual.projected.x - residual.observed.x) * vectorScale;
            const endY =
              residual.observed.y +
              (residual.projected.y - residual.observed.y) * vectorScale;
            return (
              <g key={residual.pointId}>
                <line
                  x1={residual.observed.x}
                  y1={residual.observed.y}
                  x2={endX}
                  y2={endY}
                />
                <circle cx={residual.observed.x} cy={residual.observed.y} r={2.5} />
              </g>
            );
          })}
        </svg>
        <span>#{index + 1}</span>
      </div>
      <div class="observation-details">
        <strong>{observation.sourceName ?? `${observation.source} capture`}</strong>
        <small>{error.toFixed(3)} px RMS · vectors ×{vectorScale}</small>
      </div>
    </article>
  );
}

export function CalibrationDiagnostics({
  result,
  observations,
}: {
  result: CalibrationResultV1;
  observations: FrameObservation[];
}) {
  const health = useMemo(
    () => calibrationHealth(result, observations),
    [result, observations],
  );
  const observationsById = useMemo(
    () => new Map(observations.map((observation) => [observation.id, observation])),
    [observations],
  );
  const worstViews = result.includedViewIds
    .map((viewId) => ({
      viewId,
      observation: observationsById.get(viewId),
      residuals: result.residuals?.[viewId],
      error: result.perViewErrors[viewId],
    }))
    .filter(
      (entry): entry is {
        viewId: string;
        observation: FrameObservation;
        residuals: PointResidual[];
        error: number;
      } =>
        entry.observation !== undefined &&
        entry.residuals !== undefined &&
        typeof entry.error === "number",
    )
    .sort((left, right) => right.error - left.error)
    .slice(0, 3);
  const stability = result.stability;

  return (
    <section class="panel full-width diagnostics-panel">
      <div class="panel-heading"><h2>Calibration diagnostics</h2></div>
      <div class="health-metrics">
        <div><span>Median error</span><strong>{health.errorMedian.toFixed(3)} px</strong></div>
        <div><span>95th percentile</span><strong>{health.errorP95.toFixed(3)} px</strong></div>
        <div><span>Worst view</span><strong>{health.errorMaximum.toFixed(3)} px</strong></div>
        <div><span>Observed cells</span><strong>{Math.round(health.occupiedCellRatio * 100)}%</strong></div>
        <div><span>Observed edge cells</span><strong>{Math.round(health.occupiedEdgeCellRatio * 100)}%</strong></div>
        <div><span>Tilt range</span><strong>{health.minimumTiltDegrees.toFixed(0)}°–{health.maximumTiltDegrees.toFixed(0)}°</strong></div>
        <div><span>Tilt directions</span><strong>{health.tiltDirections.length} / 4</strong></div>
        <div><span>Principal-point offset</span><strong>{health.principalPointOffsetPx.toFixed(1)} px</strong></div>
      </div>
      <div class="diagnostic-maps">
        <DiagnosticHeatmap
          label="Detected point coverage"
          values={health.pointGrid}
          valueLabel={(value) => `${Math.round(value)} detected points`}
        />
        <DiagnosticHeatmap
          label="Mean reprojection residual"
          values={health.residualGrid}
          counts={health.residualGridCounts}
          valueLabel={(value, count) =>
            count > 0 ? `${value.toFixed(3)} px across ${count} points` : "No observations"
          }
        />
      </div>
      {stability && (
        <div class="stability-summary">
          <h3>Sampled leave-one-view-out variation</h3>
          <dl>
            <div><dt>Successful subsets</dt><dd>{stability.successfulSamples} / {stability.attemptedSamples}</dd></div>
            <div><dt>Focal variation</dt><dd>{health.focalVariationPercent === undefined ? "Unavailable" : `${health.focalVariationPercent.toFixed(3)}%`}</dd></div>
            <div><dt>Principal-point variation</dt><dd>{health.principalPointVariationPx === undefined ? "Unavailable" : `${health.principalPointVariationPx.toFixed(3)} px`}</dd></div>
          </dl>
        </div>
      )}
      {!stability && <p class="muted">Use more than 12 included views to measure leave-one-view-out variation.</p>}
      {health.warnings.length > 0 && (
        <div class="diagnostic-warnings" aria-label="Calibration warnings">
          {health.warnings.map((warning) => <div class="status status-info" role="status" key={warning}>{warning}</div>)}
        </div>
      )}
      {worstViews.length > 0 ? (
        <>
          <h3 class="subsection-title">Worst-fitting views</h3>
          <div class="residual-grid">
            {worstViews.map(({ viewId, observation, residuals, error }) => (
              <ResidualViewCard
                key={viewId}
                observation={observation}
                residuals={residuals}
                error={error}
                index={observations.findIndex((candidate) => candidate.id === viewId)}
              />
            ))}
          </div>
        </>
      ) : (
        <p class="muted">Rerun this calibration to generate point-level residual diagnostics.</p>
      )}
    </section>
  );
}
