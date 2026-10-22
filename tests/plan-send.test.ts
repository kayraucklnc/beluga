import { describe, expect, it } from 'vitest';
import { type PlanSendApi, sendPlanMessage } from '../packages/mac/src/plans/plan-send.js';

/** A fake API: `expand` fails the first `failExpand` times, `submit` answers with `went`. */
function fakeApi({ failExpand = 0, went = true as boolean | void } = {}): PlanSendApi & { sent: string[] } {
  const sent: string[] = [];
  let fails = failExpand;
  return {
    sent,
    attachments: {
      expand: async (text) => {
        if (fails-- > 0) throw new Error('the image is busy');
        return text.replace(/\[image (\d+)\]/g, '![image $1](/tmp/$1.png)');
      },
    },
    session: {
      submit: async (text) => {
        sent.push(text);
        return went;
      },
    },
  };
}

describe('plan chat send (KLD-66)', () => {
  it('Retry after a failed image expand sends the expanded message exactly once', async () => {
    const api = fakeApi({ failExpand: 1 });
    const typed = 'look at [image 3]';
    await expect(sendPlanMessage(api, typed, 'ws:plan')).rejects.toThrow("Couldn't send the images: the image is busy");
    expect(api.sent).toEqual([]);
    // Retry sends what was typed again; its images are expanded this time.
    await sendPlanMessage(api, typed, 'ws:plan');
    expect(api.sent).toEqual(['look at ![image 3](/tmp/3.png)']);
  });

  it('a send that resolves but did not go is an error', async () => {
    await expect(sendPlanMessage(fakeApi({ went: false }), 'hi', 'ws:plan')).rejects.toThrow("Claude can't be asked here");
    // Older daemons answer nothing: that's a send.
    await expect(sendPlanMessage(fakeApi({ went: undefined }), 'hi', 'ws:plan')).resolves.toBeUndefined();
  });

  it('a rejected send keeps its reason, and commands go as typed', async () => {
    const api = fakeApi();
    api.session.submit = async () => {
      throw new Error('not connected');
    };
    await expect(sendPlanMessage(api, 'hi', 'ws:plan')).rejects.toThrow('not connected');
    const plain = fakeApi();
    await sendPlanMessage(plain, '/compact [image 1]', 'ws:plan');
    expect(plain.sent).toEqual(['/compact [image 1]']);
  });
});
