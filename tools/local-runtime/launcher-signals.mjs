const SHUTDOWN_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);

export function installShutdownSignals(processLike, resolveSignal) {
  if (
    processLike === null
    || typeof processLike !== 'object'
    || processLike.stdin === null
    || typeof processLike.stdin !== 'object'
    || typeof processLike.once !== 'function'
    || typeof processLike.removeListener !== 'function'
    || typeof processLike.stdin.once !== 'function'
    || typeof processLike.stdin.removeListener !== 'function'
    || typeof processLike.stdin.resume !== 'function'
    || typeof processLike.stdin.pause !== 'function'
    || typeof resolveSignal !== 'function'
  ) {
    throw new TypeError('A process with a controllable stdin and a signal resolver is required.');
  }

  const signalHandlers = new Map(
    SHUTDOWN_SIGNALS.map((signal) => [signal, () => resolveSignal(signal)]),
  );
  const stdinEndHandler = () => resolveSignal('stdin-eof');

  for (const [signal, handler] of signalHandlers) processLike.once(signal, handler);
  processLike.stdin.once('end', stdinEndHandler);
  processLike.stdin.resume();

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const [signal, handler] of signalHandlers) {
      processLike.removeListener(signal, handler);
    }
    processLike.stdin.removeListener('end', stdinEndHandler);
    processLike.stdin.pause();
  };
}
