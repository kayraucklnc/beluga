import { FormSheet } from '../components/FormSheet.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { openSettings } from '../lib/native-routes.js';
import { EnvEditor } from './EnvironmentSettings.js';
import e from './env-settings.module.css';

/**
 * A project's Environment… (BLG-369): its variables beside its main folder's .env, from the
 * project's ••• menu or its page, without going through Settings. The same editor as
 * Settings › Environment's, for this project.
 */
export function EnvironmentSheet({ projectId, close }: { projectId: string; close: () => void }) {
  const { ui } = useBeluga();
  const name = useApp((st) => st.projects.find((p) => p.id === projectId)?.name);
  if (!name) return null;
  return (
    <FormSheet
      title={`Environment for ${name}`}
      icon="lock"
      intro="Given to shells, setup and run commands in its workspaces, and your agent. They stay on this Mac."
      submitLabel="Done"
      hideSubmit
      cancelLabel="Done"
      width={640}
      onSubmit={close}
      onCancel={close}
      footer={
        <button
          type="button"
          className={e.inlineLink}
          onClick={() => {
            close();
            openSettings(ui, 'environment');
          }}
        >
          Your variables for every project…
        </button>
      }
    >
      <div className={e.sheetBody}>
        <EnvEditor projectId={projectId} />
      </div>
    </FormSheet>
  );
}
