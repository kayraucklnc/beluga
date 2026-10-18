/** The private share for a workspace's folder (you, and people you invite into it). */
export const shareNameOf = (id: string): string => `ws-${id.replace(/[^\w.-]/g, '_')}`;
