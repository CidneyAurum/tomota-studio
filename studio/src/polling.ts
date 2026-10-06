type Options = {visible?: () => boolean; onError?: (error: unknown) => void; immediate?: boolean};

// Schedule AFTER completion: slow endpoints cannot accumulate overlapping
// polls. Hidden views skip work, and disposal never schedules a later tick.
export function startPolling(task: () => Promise<unknown>, interval: number, options: Options = {}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = options.visible || (() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const schedule = () => {if (!stopped) timer = setTimeout(() => void tick(), interval);};
  const tick = async () => {
    if (stopped) return;
    try {if (visible()) await task();}
    catch (error) {if (!stopped) options.onError?.(error);}
    finally {schedule();}
  };
  if (options.immediate) void tick(); else schedule();
  return () => {stopped = true; if (timer !== undefined) clearTimeout(timer);};
}
