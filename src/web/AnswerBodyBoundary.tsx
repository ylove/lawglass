import { Component, type ReactNode } from 'react';

/** Keep the document usable even if answer formatting fails. */
export class AnswerBodyBoundary extends Component<
  { text: string; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? (
      <p style={{ whiteSpace: 'pre-wrap' }}>{this.props.text}</p>
    ) : (
      this.props.children
    );
  }
}
