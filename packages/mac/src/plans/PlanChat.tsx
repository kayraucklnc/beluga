import { useEffect, useMemo, useRef, useState } from "react";
import { queueIn } from "@beluga/ui/compose.js";
import { activityOf } from "@beluga/ui/workspace-models.js";
import { ChatLog } from "../chat/ChatLog.js";
import { PaneLook } from "../chat/Items.js";
import { QueueTray } from "../chat/QueueTray.js";
import { MentionHighlighter } from "../chat/MentionHighlighter.js";
import { useAttachments } from "../chat/use-attachments.js";
import { Icon } from "../components/Icon.js";
import { Empty, IconButton, Tip, Working, cx } from "../components/ui.js";
import { useActions } from "../lib/actions.js";
import { useApi, useApp, useBeluga } from "../lib/beluga.js";
import { LiveDot } from "./marks.js";
import { PlanAsk } from "./PlanAsk.js";
import { planAskOf } from "./plan-ask-model.js";
import { type PlanMessage, planMessage, sendPlanMessage } from "./plan-send.js";
import { useConversationLoaded } from "./use-plans.js";
import s from "../chat/composer.module.css";
import k from "./plan-ask.module.css";
import p from "./plans.module.css";

const FOLD = { fold: true };
const FOLD_QUIET = { fold: true, quietWorking: true };

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Talking the plan through with Claude, beside it: the plan's own conversation (its head Claude
 * plans and runs it there), and a box to say what to change. The plan updates as Claude writes.
 * The box takes pasted, dropped and path-named images and files as every message box does. This
 * is where you run the whole plan from, so the box never waits: what you send while Claude works
 * reaches it now (at its next step, or a long command is interrupted for it; ⌥↩ queues it
 * instead), Stop ends its turn, and what it asks you (a decision of yours in the plan, its
 * question) is answered right here. A send that fails says so here, with Retry.
 */
export function PlanChat({
  channel,
  draft,
  drafting,
  onClose,
}: {
  channel: string;
  draft: boolean;
  drafting: boolean;
  onClose: () => void;
}) {
  const api = useApi();
  const { client } = useBeluga();
  const actions = useActions();
  const [text, setTextState] = useState("");
  const words = useRef("");
  const setText = (next: string): void => {
    words.current = next;
    setTextState(next);
  };
  const box = useRef<HTMLTextAreaElement>(null);
  const busy = useApp((st) => activityOf(st.log, channel).running);
  const selfName = useApp((st) => st.self?.name ?? "");
  // What waits for Claude here (picked as text, so streaming doesn't redraw this pane).
  const queued = useApp((st) =>
    JSON.stringify(queueIn(st, channel, st.selfId)),
  );
  const queue = useMemo(
    () => JSON.parse(queued) as ReturnType<typeof queueIn>,
    [queued],
  );
  // What it asks you here is answered right here; an approval (or a plan to approve) in the whole conversation.
  const askJson = useApp((st) =>
    JSON.stringify(planAskOf(st.questions, channel) ?? null),
  );
  const ask = useMemo(
    () => (JSON.parse(askJson) ?? undefined) as ReturnType<typeof planAskOf>,
    [askJson],
  );
  const asking = useApp(
    (st) =>
      st.questions.some(
        (q) => q.channel === channel && q.question.kind === "plan",
      ) || st.approvals.some((a) => a.channel === channel),
  );
  const wsId = channel.startsWith("ws:") ? channel.slice(3) : undefined;
  const loading = !useConversationLoaded(channel);
  /** A message that didn't go: said under the box, with Retry. */
  const [failed, setFailed] = useState<{
    message: PlanMessage;
    error: string;
  }>();
  const att = useAttachments({
    channel,
    box,
    text: () => words.current,
    setText: (next, cursor) => {
      setText(next);
      requestAnimationFrame(() =>
        box.current?.setSelectionRange(cursor, cursor),
      );
    },
  });

  // The box grows with what you write (up to a point).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [text]);

  /**
   * Send `message` (its image references are expanded on the way); when it doesn't go, it's
   * kept, and said, for Retry, which sends that same message (see plan-send.ts). The box isn't
   * refilled, so it can't go twice.
   */
  const deliver = (message: PlanMessage, urgent = false): void => {
    setFailed(undefined);
    sendPlanMessage(api, message, channel, urgent).catch((err: unknown) =>
      setFailed({ message, error: errorText(err) }),
    );
  };
  /** While Claude works, your message reaches it now unless you queue it (⌥↩). */
  const send = (queue = false): void => {
    const { text: message, images } = att.take(text.trim());
    if (!message) return;
    setText("");
    deliver(planMessage(message, images), busy && !queue);
  };
  const stop = (): void => {
    api.host.stopRun(channel).then(
      async ({ returned }) => {
        if (!returned.length) return;
        // Your messages that were waiting come back to the box: nothing typed is lost.
        const back = [
          ...(await Promise.all(returned.map(att.restore))),
          words.current.trim(),
        ]
          .filter(Boolean)
          .join("\n");
        setText(back);
        box.current?.focus();
      },
      (err: unknown) =>
        client.store.dispatch({
          type: "toast",
          text: `Couldn't stop Claude: ${errorText(err)}`,
          level: "error",
        }),
    );
  };
  const editQueued = async (sent: string): Promise<void> => {
    const prompt = await att.restore(sent);
    const current = words.current.trim();
    setText(current ? `${prompt}\n${current}` : prompt);
    box.current?.focus();
  };

  return (
    <aside className={p.chat} aria-label="Conversation" data-drop-zone>
      {att.dropTarget}
      <header className={p.chatHead}>
        <span className={p.chatTitle}>
          <Icon name="claude" size={13} />
          Claude
        </span>
        {/* While it writes the first plan, the line under the placeholder says so (one status, not two). */}
        {busy && !drafting ? (
          <span className={p.chatBusy}>
            <LiveDot />
            working
          </span>
        ) : null}
        <span className={p.grow} />
        {wsId ? (
          <IconButton
            icon="expand"
            label="Open the Whole Conversation"
            onClick={() =>
              actions.run({ type: "open_ws", id: wsId, tab: "chat" })
            }
          />
        ) : null}
        <IconButton icon="x" label="Hide the Conversation" onClick={onClose} />
      </header>
      <div className={p.chatLog}>
        {/* A narrow pane: what you asked first folds to a few lines, so the conversation reads from the top; while the plan is being written, the line under it is Claude's one status. */}
        <PaneLook.Provider value={drafting ? FOLD_QUIET : FOLD}>
          <ChatLog
            key={channel}
            channel={channel}
            empty={
              loading ? (
                <Empty
                  icon="chat"
                  mark={<Working />}
                  title="Loading the conversation…"
                />
              ) : (
                <Empty
                  icon="flag"
                  title="Plan it together"
                  detail={
                    draft
                      ? "Claude is reading the code and writing the plan. Tell it what to change: the plan on the left updates as it goes."
                      : "Ask Claude about the plan, or tell it what to change."
                  }
                />
              )
            }
          />
        </PaneLook.Provider>
      </div>
      {ask ? <PlanAsk key={ask.qid} q={ask} /> : null}
      {asking && wsId ? (
        <button
          type="button"
          className={p.chatAsk}
          onClick={() =>
            actions.run({ type: "open_ws", id: wsId, tab: "chat" })
          }
        >
          <Icon name="alert" size={12} />
          Claude asked you something. Answer it in the conversation
        </button>
      ) : null}
      <div className={p.chatQueue}>
        <QueueTray
          queue={queue}
          selfName={selfName}
          onEdit={(prompt) => void editQueued(prompt)}
          channel={channel}
        />
      </div>
      {failed ? (
        <div className={p.chatFailed} role="alert">
          <Icon name="alert" size={12} />
          <span className={p.chatFailedText}>
            Your message wasn’t sent: {failed.error}
          </span>
          <button
            type="button"
            className={p.chatRetry}
            onClick={() => deliver(failed.message)}
          >
            Retry
          </button>
        </div>
      ) : null}
      <form
        className={cx(p.chatBox, att.dropping && s.dropping)}
        {...att.dropProps}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        {att.images.length || att.files.length ? (
          <div className={p.chatWaiting}>{att.waiting}</div>
        ) : null}
        <div className={p.chatRow}>
          <div className={cx(s.inputWrap, p.chatInputWrap)}>
            <MentionHighlighter
              text={text}
              input={box}
              className={p.chatInput ?? ""}
            />
            <textarea
              ref={box}
              className={cx(p.chatInput, s.overHighlight, "selectable")}
              rows={1}
              value={text}
              placeholder={
                busy
                  ? "Claude is working: tell it now, or stop it…"
                  : draft
                    ? "Tell Claude what to change…"
                    : "Ask about the plan, or change it…"
              }
              aria-label="Message Claude about the plan"
              onChange={(e) => setText(e.target.value)}
              onPaste={att.onPaste}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (att.onRefKey(e)) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(e.altKey);
                }
                if (e.key === "." && (e.metaKey || e.ctrlKey) && busy) {
                  e.preventDefault();
                  stop();
                }
              }}
            />
          </div>
          {busy ? (
            <Tip
              label="Stop Claude here · your queued messages come back to the box"
              keys="⌘."
            >
              <button
                type="button"
                className={k.stop}
                aria-label="Stop Claude"
                onClick={stop}
              >
                <span className={k.stopMark} />
              </button>
            </Tip>
          ) : null}
          <Tip
            label={
              busy
                ? "Send now: Claude reads it at its next step (a long command is interrupted for it) · ⌥↩ queues it instead"
                : "Send"
            }
            keys="↩"
          >
            <button
              type="button"
              className={p.chatSend}
              aria-label={busy ? "Send Now" : "Send"}
              disabled={!text.trim() && !att.images.length && !att.files.length}
              onClick={() => send()}
            >
              <Icon name="send" size={13} />
            </button>
          </Tip>
        </div>
      </form>
    </aside>
  );
}
