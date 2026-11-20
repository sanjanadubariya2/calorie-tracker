// Minimal types for react-test-renderer 18 (bundled with jest-expo), covering
// what the component tests use. Avoids adding @types/react-test-renderer.
declare module "react-test-renderer" {
  import type { ReactElement } from "react";

  export interface ReactTestInstance {
    type: unknown;
    props: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    parent: ReactTestInstance | null;
    children: (ReactTestInstance | string)[];
    findAll(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance[];
    findByProps(props: Record<string, unknown>): ReactTestInstance;
  }

  export interface ReactTestRenderer {
    root: ReactTestInstance;
    toJSON(): unknown;
    update(element: ReactElement): void;
    unmount(): void;
  }

  export function create(element: ReactElement): ReactTestRenderer;
  export function act(callback: () => void): void;
  export function act(callback: () => Promise<void>): Promise<void>;

  const TestRenderer: { create: typeof create; act: typeof act };
  export default TestRenderer;
}
