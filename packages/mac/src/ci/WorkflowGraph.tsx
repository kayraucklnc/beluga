import { useEffect, useMemo, useState } from 'react';
import type { GhJob } from '@beluga/core/ci/model.js';
import { type WorkflowShape, readWorkflow, workflowGraph } from '@beluga/core/ci/workflow-graph.js';
import { GraphBlock } from '../components/graph/GraphBlock.js';
import s from './ci.module.css';

/** The YAML reader, loaded the first time a workflow is drawn. */
let yaml: Promise<typeof import('yaml')> | undefined;
const loadYaml = (): Promise<typeof import('yaml')> => (yaml ??= import('yaml'));

/** A workflow file's shape, read once its YAML reader is in (undefined meanwhile; an error says what's wrong). */
export function useWorkflowShape(text: string | undefined): { readonly shape?: WorkflowShape; readonly error?: string } {
  const [got, setGot] = useState<{ readonly text: string; readonly shape?: WorkflowShape; readonly error?: string }>();
  useEffect(() => {
    if (text === undefined) return;
    let gone = false;
    loadYaml().then(
      (y) => {
        if (gone) return;
        try {
          const shape = readWorkflow(y.parse(text, { uniqueKeys: false }));
          setGot(shape ? { text, shape } : { text, error: 'This file has no jobs to draw' });
        } catch (err) {
          setGot({ text, error: err instanceof Error ? err.message.split('\n')[0]! : String(err) });
        }
      },
      () => !gone && setGot({ text, error: 'Couldn’t load the YAML reader' }),
    );
    return () => void (gone = true);
  }, [text]);
  return got && got.text === text ? { ...(got.shape ? { shape: got.shape } : {}), ...(got.error ? { error: got.error } : {}) } : {};
}

/**
 * A workflow drawn as a graph: what starts it, its jobs, what needs what. Given a run's jobs, each
 * is coloured by how it's going (redrawn when GitHub says something changed, not every second).
 */
export function WorkflowGraph({ text, path, title, jobs }: { text: string; path: string; title?: string; jobs?: readonly GhJob[] }) {
  const { shape, error } = useWorkflowShape(text);
  const code = useMemo(() => (shape ? JSON.stringify(workflowGraph(shape, { path, ...(title ? { title } : {}), ...(jobs ? { jobs } : {}) })) : undefined), [shape, path, title, jobs]);
  if (error) return <p className={s.graphNote}>Can’t draw {path.split('/').pop()}: {error}</p>;
  if (!code) return <div className={s.graphWait} aria-label="Drawing the workflow" />;
  return <GraphBlock code={code} />;
}
