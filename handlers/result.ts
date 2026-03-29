export function result(text: string, details: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
  };
}

export function notRegisteredError() {
  return result(
    'Not registered. Use pi_messenger({ action: "join" }) to join the agent mesh first.',
    { mode: 'error', error: 'not_registered' }
  );
}
