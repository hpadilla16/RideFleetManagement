/**
 * In-memory event bus for chat SSE connections.
 * Maps conversationId → Set<{ res, role }>
 */
const connections = new Map();

export function addConnection(conversationId, res, role) {
  if (!connections.has(conversationId)) connections.set(conversationId, new Set());
  const entry = { res, role };
  connections.get(conversationId).add(entry);
  return () => {
    connections.get(conversationId)?.delete(entry);
    if (connections.get(conversationId)?.size === 0) connections.delete(conversationId);
  };
}

export function broadcastToConversation(conversationId, event, data, excludeRole) {
  const conns = connections.get(conversationId);
  if (!conns) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const { res, role } of conns) {
    if (excludeRole && role === excludeRole) continue;
    try { res.write(payload); } catch {}
  }
}

export function getConnectionCount(conversationId) {
  return connections.get(conversationId)?.size || 0;
}
