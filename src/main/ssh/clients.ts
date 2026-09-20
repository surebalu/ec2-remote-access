/**
 * Registry of live ssh2 clients by session id, so a Files tab can open its SFTP channel on the connection an SSH
 * tab already authenticated (and vice versa) instead of logging in again.
 */
import type ssh2 from 'ssh2'
type Client = InstanceType<typeof ssh2.Client>

export interface LiveClient {
  client: Client
  instanceKey: string
  user: string
  /** Session ids that currently depend on this client (the owner plus any sharers). */
  users: Set<string>
}

const clients = new Map<string, LiveClient>()

export function registerClient(sessionId: string, entry: Omit<LiveClient, 'users'>): void {
  clients.set(sessionId, { ...entry, users: new Set([sessionId]) })
}

export function unregisterClient(sessionId: string): void {
  clients.delete(sessionId)
}

/** Returns the client behind `sessionId` if it is still connected and belongs to the same host and user. */
export function lookupClient(sessionId: string | undefined, instanceKey: string, user: string): LiveClient | undefined {
  if (!sessionId) return undefined
  const c = clients.get(sessionId)
  if (!c || c.instanceKey !== instanceKey || c.user !== user) return undefined
  return c
}
