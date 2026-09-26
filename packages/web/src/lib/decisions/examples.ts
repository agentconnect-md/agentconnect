// Starting points offered on an empty Decisions page; each opens the editor prefilled, nothing is saved until the user does.

import type { DecisionQuestion } from '@agentconnect.md/protocol/decision'

export type DecisionExampleId =
  'needsReply' | 'spam' | 'supportCategory' | 'issueType' | 'prFocus' | 'prAuthor' | 'taskComplexity'

export interface DecisionExample {
  /** Stable id for the `?example=` link and the hint's message key. */
  id: DecisionExampleId
  name: string
  question: DecisionQuestion
}

export const DECISION_EXAMPLES: readonly DecisionExample[] = [
  {
    id: 'needsReply',
    name: 'Needs reply',
    question: {
      type: 'boolean',
      instructions: 'Given history, does currentMessage need an answer from an agent?',
      criteria: {
        true: 'A question or request for help, even one phrased as a statement.',
        false: 'Greetings, thanks, chit-chat, or a message meant for someone else.'
      }
    }
  },
  {
    id: 'spam',
    name: 'Spam',
    question: {
      type: 'score',
      instructions: 'How spammy is currentMessage? Use history to spot repeat senders.',
      criteria: [
        'Normal message',
        'Suspicious: promotional or link-heavy, possibly genuine',
        'Spam: ads, scams, phishing, or flooding',
        'Repeat spam: this sender has spammed here before'
      ]
    }
  },
  {
    id: 'supportCategory',
    name: 'Support category',
    question: {
      type: 'choice',
      instructions: 'What does the sender of currentMessage need help with?',
      criteria: {
        technical: 'Errors, bugs, setup, or how to use the product',
        billing: 'Payments, invoices, plans, or refunds',
        spam: 'Ads, scams, or not about support',
        other: 'Anything else'
      }
    }
  },
  {
    id: 'issueType',
    name: 'Issue type',
    question: {
      type: 'choice',
      instructions: 'What kind of issue is this, based on its title and description?',
      criteria: {
        bug: 'Something is broken or behaves unexpectedly',
        feature: 'Asks for new or changed behavior',
        question: 'Asks how or why, without reporting a defect',
        other: 'Docs, chores, discussion, or anything else'
      }
    }
  },
  {
    id: 'prFocus',
    name: 'PR focus',
    question: {
      type: 'choice',
      instructions:
        'What does this pull request mainly need reviewing for? Judge from its description, commits, and diff.',
      criteria: {
        security: 'Auth, secrets, crypto, input validation, sandboxing, or personal data',
        architecture: 'Interfaces, protocols, data models, migrations, or module boundaries',
        general: 'Everything else'
      }
    }
  },
  {
    id: 'prAuthor',
    name: 'PR author',
    question: {
      type: 'choice',
      instructions:
        'Which coding agent wrote this pull request? Check commit trailers, the description footer, and the author.',
      criteria: {
        claude: 'Claude or Claude Code',
        codex: 'Codex or another OpenAI model',
        grok: 'Grok or another xAI model',
        unknown: 'A person, or no clear attribution'
      }
    }
  },
  {
    id: 'taskComplexity',
    name: 'Task complexity',
    question: {
      type: 'score',
      instructions: 'How much work does this request take? Consider scope, ambiguity, and how much code it touches.',
      criteria: [
        'Easy: a quick answer or a small, clear change',
        'Medium: a few files, or an investigation with a clear direction',
        'Hard: open-ended, cross-cutting, or needs a design decision'
      ]
    }
  }
]

export function decisionExample(id: string | null | undefined): DecisionExample | undefined {
  return id ? DECISION_EXAMPLES.find((example) => example.id === id) : undefined
}
