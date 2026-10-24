import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reloadOnce } from '../updates'

/**
 * Keeps one broken tab from blanking the whole app: React unmounts everything above an error nobody catches. A part
 * that could not be loaded (a stale page after an update) reloads the page once; anything else shows what failed.
 */
export default class TabErrorBoundary extends Component<{ title: string; onClose: () => void; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[tab] ${this.props.title} failed:`, error, info.componentStack)
    if (/dynamically imported module|Importing a module script failed|error loading dynamically|Failed to fetch/i.test(error.message)) reloadOnce()
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="tab-failed" role="alert">
        <h2>{this.props.title} stopped working</h2>
        <p className="muted">{this.state.error.message}</p>
        <div className="flex gap-2">
          <button type="button" className="btn" onClick={this.props.onClose}>Close tab</button>
          <button type="button" className="btn btn-primary" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    )
  }
}
