import type { Session } from '../core/session.js';
import { TeamAssign } from '../core/team/assign.js';
import { needTeam } from '../core/team/launch.js';
import { TeamPlans } from '../core/team/plan-share.js';
import type { Args, Method } from './api.js';

/** What each `team.*` method does (see team-api.ts): you act as yourself. */

type TeamMethod = Extract<Method, `team.${string}`>;
type TeamHandlers = { readonly [M in TeamMethod]: (s: Session, ...args: Args<M>) => unknown };

export const TEAM_HANDLERS = {
  'team.answer': (s, peerId, projectId, yes) => needTeam(s).answer(peerId, projectId, yes),
  'team.leave': (s, projectId, peerId) => needTeam(s).leave(projectId, peerId),
  'team.ackAssignment': (s, issueId) => needTeam(s).part(TeamAssign).ack(issueId),
  'team.sharePlan': (s, planId, on) => needTeam(s).part(TeamPlans).share(planId, on),
  'team.reviewPlan': (s, owner, planId, review) => needTeam(s).part(TeamPlans).review(owner, planId, review),
  'team.applySuggestion': (s, planId, reviewId) => needTeam(s).part(TeamPlans).apply(planId, reviewId),
  'team.dismissSuggestion': (s, planId, reviewId) => needTeam(s).part(TeamPlans).dismiss(planId, reviewId),
} satisfies TeamHandlers;
