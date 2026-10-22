// The part of node-oracledb (thin mode) that main/dbLocks.ts uses; the package ships no type declarations.
declare module 'oracledb' {
  export interface Connection {
    execute<T = Record<string, unknown>>(sql: string, binds?: unknown[] | Record<string, unknown>, options?: { outFormat?: number; maxRows?: number; autoCommit?: boolean }): Promise<{ rows?: T[] }>
    ping(): Promise<void>
    close(): Promise<void>
    module: string
    action: string
    clientInfo: string
    callTimeout: number
  }
  export const OUT_FORMAT_OBJECT: number
  export function getConnection(attrs: { user: string; password: string; connectString: string; connectTimeout?: number; transportConnectTimeout?: number }): Promise<Connection>
  const oracledb: { OUT_FORMAT_OBJECT: number; getConnection: typeof getConnection }
  export default oracledb
}
