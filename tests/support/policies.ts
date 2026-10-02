import { createAgentPolicies } from '../../src/domain/agent-policy';

export const PROJECT_POLICIES = createAgentPolicies({ webSearch: false });

export const WEB_POLICIES = createAgentPolicies({ webSearch: true });

export const MAIN_AGENT_POLICY = PROJECT_POLICIES.main;
