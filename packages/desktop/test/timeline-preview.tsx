import { type ComponentProps, useState } from "react";
import { useTimelinePreferences } from "../src/connection.js";
import { TimelinePreview as Preview } from "../src/TimelinePreview.js";

export function TimelinePreview(props: Omit<ComponentProps<typeof Preview>, "preferences">) {
  const [error, setError] = useState<string | null>(null);
  const preferences = useTimelinePreferences(props.call, setError, props.state, props.update);
  return <Preview {...props} preferences={preferences} error={props.error ?? error} />;
}
