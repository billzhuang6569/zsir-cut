import { useEffect, useId, useRef, useState } from "react";
import type { Transform } from "../../core/src/project/types.js";
import {
  type ClipEdit,
  clipRateChange,
  currentClipRate,
  type GainPreview,
  selectedClips,
  setClips,
} from "./clipProperties.js";
import type { ProjectView } from "./connection.js";
import { div, parseRational, sub } from "./timeline.js";
import "./clip-properties.css";

function common<T>(values: T[]) {
  return values.every((value) => value === values[0]) ? values[0] : undefined;
}

function Field({
  label,
  value,
  reason,
  save,
}: {
  label: string;
  value?: string | number | undefined;
  reason?: string | undefined;
  save: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string>();
  const cancel = useRef(false);
  const description = useId();
  return (
    <label className="zc-clip-field">
      <span>{label}</span>
      <input
        value={draft ?? value ?? ""}
        placeholder={value === undefined && !reason ? "多个值" : undefined}
        disabled={!!reason}
        aria-describedby={reason ? description : undefined}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => {
          if (!cancel.current && draft !== undefined && draft !== String(value ?? "")) save(draft);
          cancel.current = false;
          setDraft(undefined);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") cancel.current = true;
          if (event.key === "Escape" || event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      {reason && <small id={description}>{reason}</small>}
    </label>
  );
}

const transformFields: {
  name: string;
  read: (transform: Transform) => number;
  write: (transform: Transform, value: number) => Transform;
  min?: number;
  max?: number;
}[] = [
  {
    name: "缩放",
    read: (t: Transform) => t.scale ?? 1,
    write: (t: Transform, scale: number) => ({ ...t, scale }),
    min: Number.MIN_VALUE,
  },
  {
    name: "旋转（°）",
    read: (t: Transform) => t.rotation_deg ?? 0,
    write: (t: Transform, rotation_deg: number) => ({ ...t, rotation_deg }),
  },
  {
    name: "横向位置",
    read: (t: Transform) => t.position?.[0] ?? 0,
    write: (t: Transform, x: number) => ({
      ...t,
      position: [x, t.position?.[1] ?? 0] as [number, number],
    }),
  },
  {
    name: "纵向位置",
    read: (t: Transform) => t.position?.[1] ?? 0,
    write: (t: Transform, y: number) => ({
      ...t,
      position: [t.position?.[0] ?? 0, y] as [number, number],
    }),
  },
  ...(
    [
      ["left", "左"],
      ["top", "上"],
      ["right", "右"],
      ["bottom", "下"],
    ] as const
  ).map(([edge, name]) => ({
    name: `裁切${name}侧`,
    read: (t: Transform) => t.crop?.[edge] ?? 0,
    write: (t: Transform, value: number) => ({ ...t, crop: { ...t.crop, [edge]: value } }),
    min: 0,
    max: 1,
  })),
];

export function ClipInspector({
  project,
  ids,
  blocked,
  gainPreview,
  previewGain,
  edit,
}: {
  project: ProjectView;
  ids: string[];
  blocked?: string | undefined;
  gainPreview: GainPreview | null;
  previewGain: (value: GainPreview | null) => void;
  edit: ClipEdit;
}) {
  const [error, setError] = useState<string>();
  const gainDraft = useRef<number>();
  useEffect(() => () => previewGain(null), [previewGain]);
  const targets = selectedClips(project, ids);
  const clipIds = targets.map(({ clip }) => clip.id);
  if (!targets.length) return null;
  const single = targets.length === 1 ? targets[0]?.clip : undefined;
  const enabled = common(targets.map(({ clip }) => clip.enabled));
  const gain = common(targets.map(({ clip }) => clip.gain_db ?? 0));
  const media = project.media.find(({ id }) => id === single?.media_id);
  const rate = common(targets.map(({ clip }) => currentClipRate(clip)));
  const rateReason =
    blocked ??
    (targets.some(({ clip }) => currentClipRate(clip) === null)
      ? "片段已有分段变速、速度坡度或定格"
      : targets.some(({ clip }) => project.media.find(({ id }) => id === clip.media_id)?.kind === "image")
        ? "静态图片无法调整倍速"
        : targets.some(
              ({ clip }) =>
                div(
                  sub(parseRational(clip.timeline_out.t, true), parseRational(clip.timeline_in.t, true)),
                  div(parseRational("1"), parseRational(project.edit_rate)),
                ).denominator !== 1n,
            )
          ? "片段时长未对齐时间线帧"
          : undefined);

  const apply = (label: string, ops: unknown[]) => {
    setError(undefined);
    if (ops.length) edit(label, ops);
  };

  const saveGain = (input: string) => {
    const db = Number(input);
    if (!input.trim() || !Number.isFinite(db) || db < -60 || db > 12) {
      setError("输入 -60 到 +12 dB 之间的音量");
      return;
    }
    apply(`把片段音量改成 ${db} dB`, setClips(clipIds, { gain_db: db }));
  };
  const finishGain = () => {
    const db = gainDraft.current;
    gainDraft.current = undefined;
    previewGain(null);
    if (db !== undefined && db !== gain && !blocked) saveGain(String(db));
  };

  return (
    <section className="zc-clip-inspector" aria-label="片段属性" tabIndex={-1}>
      {single && (
        <Field
          label="名字"
          value={single.label ?? media?.name ?? single.media_id}
          reason={blocked}
          save={(label) => apply("重命名片段", setClips(clipIds, { label: label.trim() || null }))}
        />
      )}
      <label className="zc-clip-enabled">
        <input
          type="checkbox"
          checked={enabled === true}
          ref={(input) => {
            if (input) input.indeterminate = enabled === undefined;
          }}
          disabled={!!blocked}
          onChange={(event) => {
            const enabled = event.currentTarget.checked;
            apply(enabled ? "启用片段" : "停用片段", setClips(clipIds, { enabled }));
          }}
        />
        启用
      </label>
      {blocked && <small>{blocked}</small>}
      {targets.every(({ track }) => track.kind === "audio") && (
        <div className="zc-clip-gain">
          <input
            type="range"
            min={-60}
            max={12}
            step={0.1}
            aria-label="调节音量"
            disabled={!!blocked}
            value={gainPreview?.db ?? gain ?? 0}
            onChange={(event) => {
              const db = event.currentTarget.valueAsNumber;
              gainDraft.current = db;
              previewGain({ ids: clipIds, db });
            }}
            onPointerDown={(event) => event.currentTarget.setPointerCapture?.(event.pointerId)}
            onPointerUp={finishGain}
            onPointerCancel={() => {
              gainDraft.current = undefined;
              previewGain(null);
            }}
            onKeyUp={finishGain}
            onBlur={finishGain}
          />
          <Field label="音量（dB）" value={gainPreview?.db ?? gain} reason={blocked} save={saveGain} />
        </div>
      )}
      <Field
        label="倍速"
        value={rate ?? undefined}
        reason={rateReason}
        save={(input) => {
          try {
            const changes = targets.flatMap(({ clip }) => {
              const source = project.media.find(({ id }) => id === clip.media_id);
              const change = clipRateChange(clip, input, source?.duration);
              return change.rate === currentClipRate(clip) && (change.time_map !== null || !clip.time_map)
                ? []
                : [{ op: "set_clip", clip_id: clip.id, time_map: change.time_map }];
            });
            apply(`把片段倍速改成 ${input.trim()}`, changes);
          } catch (error) {
            setError(error instanceof Error ? error.message : "检查片段倍速");
          }
        }}
      />
      {targets.some(({ clip }) => !!clip.time_map) && <small>变速片段无法修剪</small>}
      {targets.every(({ track }) => track.kind === "video") && (
        <fieldset>
          <legend>位置大小</legend>
          {transformFields.map(({ name, read, write, min, max }) => (
            <Field
              key={name}
              label={name}
              reason={blocked}
              value={common(clipIds.map((id) => read(project.clipProperties?.[id]?.transform ?? {})))}
              save={(input) => {
                const value = Number(input);
                if (
                  !input.trim() ||
                  !Number.isFinite(value) ||
                  value < (min ?? -Infinity) ||
                  value > (max ?? Infinity)
                ) {
                  setError(`检查${name}的数值`);
                  return;
                }
                apply(
                  `调整片段${name}`,
                  clipIds.map((clip_id) => ({
                    op: "set_clip",
                    clip_id,
                    transform: write(project.clipProperties?.[clip_id]?.transform ?? {}, value),
                  })),
                );
              }}
            />
          ))}
        </fieldset>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
