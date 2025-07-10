/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Config,
  ToolCallRequestInfo,
  ExecutingToolCall,
  ScheduledToolCall,
  ValidatingToolCall,
  WaitingToolCall,
  CompletedToolCall,
  CancelledToolCall,
  CoreToolScheduler,
  OutputUpdateHandler,
  AllToolCallsCompleteHandler,
  ToolCallsUpdateHandler,
  Tool,
  ToolCall,
  Status as CoreStatus,
  EditorType,
  TygentScheduler,
  ToolResult,
} from '@google/gemini-cli-core';
import { useCallback, useState, useMemo } from 'react';
import { Part, PartListUnion } from '@google/genai';
import {
  HistoryItemToolGroup,
  IndividualToolCallDisplay,
  ToolCallStatus,
  HistoryItemWithoutId,
} from '../types.js';

export type ScheduleFn = (
  request: ToolCallRequestInfo | ToolCallRequestInfo[],
  signal: AbortSignal,
) => void;
export type MarkToolsAsSubmittedFn = (callIds: string[]) => void;

export type TrackedScheduledToolCall = ScheduledToolCall & {
  responseSubmittedToGemini?: boolean;
};
export type TrackedValidatingToolCall = ValidatingToolCall & {
  responseSubmittedToGemini?: boolean;
};
export type TrackedWaitingToolCall = WaitingToolCall & {
  responseSubmittedToGemini?: boolean;
};
export type TrackedExecutingToolCall = ExecutingToolCall & {
  responseSubmittedToGemini?: boolean;
};
export type TrackedCompletedToolCall = CompletedToolCall & {
  responseSubmittedToGemini?: boolean;
};
export type TrackedCancelledToolCall = CancelledToolCall & {
  responseSubmittedToGemini?: boolean;
};

export type TrackedToolCall =
  | TrackedScheduledToolCall
  | TrackedValidatingToolCall
  | TrackedWaitingToolCall
  | TrackedExecutingToolCall
  | TrackedCompletedToolCall
  | TrackedCancelledToolCall;

function createFunctionResponsePart(
  callId: string,
  toolName: string,
  output: string,
): Part {
  return {
    functionResponse: {
      id: callId,
      name: toolName,
      response: { output },
    },
  };
}

function convertToFunctionResponse(
  toolName: string,
  callId: string,
  llmContent: PartListUnion,
): PartListUnion {
  const contentToProcess =
    Array.isArray(llmContent) && llmContent.length === 1
      ? llmContent[0]
      : llmContent;

  if (typeof contentToProcess === 'string') {
    return createFunctionResponsePart(callId, toolName, contentToProcess);
  }

  if (Array.isArray(contentToProcess)) {
    const functionResponse = createFunctionResponsePart(
      callId,
      toolName,
      'Tool execution succeeded.',
    );
    return [functionResponse, ...contentToProcess];
  }

  if (contentToProcess.text !== undefined) {
    return createFunctionResponsePart(callId, toolName, contentToProcess.text);
  }

  return createFunctionResponsePart(
    callId,
    toolName,
    'Tool execution succeeded.',
  );
}

export function useReactToolScheduler(
  onComplete: (tools: CompletedToolCall[]) => void,
  config: Config,
  setPendingHistoryItem: React.Dispatch<
    React.SetStateAction<HistoryItemWithoutId | null>
  >,
  getPreferredEditor: () => EditorType | undefined,
): [TrackedToolCall[], ScheduleFn, MarkToolsAsSubmittedFn] {
  const [toolCallsForDisplay, setToolCallsForDisplay] = useState<
    TrackedToolCall[]
  >([]);

  const outputUpdateHandler: OutputUpdateHandler = useCallback(
    (toolCallId, outputChunk) => {
      setPendingHistoryItem((prevItem) => {
        if (prevItem?.type === 'tool_group') {
          return {
            ...prevItem,
            tools: prevItem.tools.map((toolDisplay) =>
              toolDisplay.callId === toolCallId &&
              toolDisplay.status === ToolCallStatus.Executing
                ? { ...toolDisplay, resultDisplay: outputChunk }
                : toolDisplay,
            ),
          };
        }
        return prevItem;
      });

      setToolCallsForDisplay((prevCalls) =>
        prevCalls.map((tc) => {
          if (tc.request.callId === toolCallId && tc.status === 'executing') {
            const executingTc = tc as TrackedExecutingToolCall;
            return { ...executingTc, liveOutput: outputChunk };
          }
          return tc;
        }),
      );
    },
    [setPendingHistoryItem],
  );

  const allToolCallsCompleteHandler: AllToolCallsCompleteHandler = useCallback(
    (completedToolCalls) => {
      onComplete(completedToolCalls);
    },
    [onComplete],
  );

  const toolCallsUpdateHandler: ToolCallsUpdateHandler = useCallback(
    (updatedCoreToolCalls: ToolCall[]) => {
      setToolCallsForDisplay((prevTrackedCalls) =>
        updatedCoreToolCalls.map((coreTc) => {
          const existingTrackedCall = prevTrackedCalls.find(
            (ptc) => ptc.request.callId === coreTc.request.callId,
          );
          const newTrackedCall: TrackedToolCall = {
            ...coreTc,
            responseSubmittedToGemini:
              existingTrackedCall?.responseSubmittedToGemini ?? false,
          } as TrackedToolCall;
          return newTrackedCall;
        }),
      );
    },
    [setToolCallsForDisplay],
  );

  const useTygent = config.isTygentEnabled();

  const scheduler = useMemo(
    () =>
      useTygent
        ? null
        : new CoreToolScheduler({
            toolRegistry: config.getToolRegistry(),
            outputUpdateHandler,
            onAllToolCallsComplete: allToolCallsCompleteHandler,
            onToolCallsUpdate: toolCallsUpdateHandler,
            approvalMode: config.getApprovalMode(),
            getPreferredEditor,
            config,
          }),
    [
      useTygent,
      config,
      outputUpdateHandler,
      allToolCallsCompleteHandler,
      toolCallsUpdateHandler,
      getPreferredEditor,
    ],
  );

  const tygentSchedule = useCallback(
    async (requests: ToolCallRequestInfo[], _signal: AbortSignal) => {
      const registry = await config.getToolRegistry();
      const client = config.getGeminiClient();
      const tygent = new TygentScheduler(client, registry);
      const executingCalls: TrackedToolCall[] = requests.map((req) => ({
        status: 'executing',
        request: req,
        tool: registry.getTool(req.name) as Tool,
      }));
      setToolCallsForDisplay(executingCalls);
      requests.forEach((r) => tygent.addToolCall(r));
      const results = await tygent.run();
      const completed: CompletedToolCall[] = requests.map((req) => {
        const tool = registry.getTool(req.name) as Tool;
        const res = results[`tool_${req.callId}`] as ToolResult;
        return {
          status: 'success',
          request: req,
          tool,
          response: {
            callId: req.callId,
            responseParts: convertToFunctionResponse(
              req.name,
              req.callId,
              res.llmContent,
            ),
            resultDisplay: res.returnDisplay,
            error: undefined,
          },
        } as CompletedToolCall;
      });
      setToolCallsForDisplay(completed as TrackedToolCall[]);
      onComplete(completed);
    },
    [config, onComplete],
  );

  const schedule: ScheduleFn = useCallback(
    (
      request: ToolCallRequestInfo | ToolCallRequestInfo[],
      signal: AbortSignal,
    ) => {
      const requests = Array.isArray(request) ? request : [request];
      if (useTygent) {
        void tygentSchedule(requests, signal);
      } else {
        scheduler?.schedule(requests, signal);
      }
    },
    [scheduler, useTygent, tygentSchedule],
  );

  const markToolsAsSubmitted: MarkToolsAsSubmittedFn = useCallback(
    (callIdsToMark: string[]) => {
      setToolCallsForDisplay((prevCalls) =>
        prevCalls.map((tc) =>
          callIdsToMark.includes(tc.request.callId)
            ? { ...tc, responseSubmittedToGemini: true }
            : tc,
        ),
      );
    },
    [],
  );

  return [toolCallsForDisplay, schedule, markToolsAsSubmitted];
}

/**
 * Maps a CoreToolScheduler status to the UI's ToolCallStatus enum.
 */
function mapCoreStatusToDisplayStatus(coreStatus: CoreStatus): ToolCallStatus {
  switch (coreStatus) {
    case 'validating':
      return ToolCallStatus.Executing;
    case 'awaiting_approval':
      return ToolCallStatus.Confirming;
    case 'executing':
      return ToolCallStatus.Executing;
    case 'success':
      return ToolCallStatus.Success;
    case 'cancelled':
      return ToolCallStatus.Canceled;
    case 'error':
      return ToolCallStatus.Error;
    case 'scheduled':
      return ToolCallStatus.Pending;
    default: {
      const exhaustiveCheck: never = coreStatus;
      console.warn(`Unknown core status encountered: ${exhaustiveCheck}`);
      return ToolCallStatus.Error;
    }
  }
}

/**
 * Transforms `TrackedToolCall` objects into `HistoryItemToolGroup` objects for UI display.
 */
export function mapToDisplay(
  toolOrTools: TrackedToolCall[] | TrackedToolCall,
): HistoryItemToolGroup {
  const toolCalls = Array.isArray(toolOrTools) ? toolOrTools : [toolOrTools];

  const toolDisplays = toolCalls.map(
    (trackedCall): IndividualToolCallDisplay => {
      let displayName = trackedCall.request.name;
      let description = '';
      let renderOutputAsMarkdown = false;

      const currentToolInstance =
        'tool' in trackedCall && trackedCall.tool
          ? (trackedCall as { tool: Tool }).tool
          : undefined;

      if (currentToolInstance) {
        displayName = currentToolInstance.displayName;
        description = currentToolInstance.getDescription(
          trackedCall.request.args,
        );
        renderOutputAsMarkdown = currentToolInstance.isOutputMarkdown;
      } else if ('request' in trackedCall && 'args' in trackedCall.request) {
        description = JSON.stringify(trackedCall.request.args);
      }

      const baseDisplayProperties: Omit<
        IndividualToolCallDisplay,
        'status' | 'resultDisplay' | 'confirmationDetails'
      > = {
        callId: trackedCall.request.callId,
        name: displayName,
        description,
        renderOutputAsMarkdown,
      };

      switch (trackedCall.status) {
        case 'success':
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay: trackedCall.response.resultDisplay,
            confirmationDetails: undefined,
          };
        case 'error':
          return {
            ...baseDisplayProperties,
            name: currentToolInstance?.displayName ?? trackedCall.request.name,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay: trackedCall.response.resultDisplay,
            confirmationDetails: undefined,
          };
        case 'cancelled':
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay: trackedCall.response.resultDisplay,
            confirmationDetails: undefined,
          };
        case 'awaiting_approval':
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay: undefined,
            confirmationDetails: trackedCall.confirmationDetails,
          };
        case 'executing':
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay:
              (trackedCall as TrackedExecutingToolCall).liveOutput ?? undefined,
            confirmationDetails: undefined,
          };
        case 'validating': // Fallthrough
        case 'scheduled':
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay: undefined,
            confirmationDetails: undefined,
          };
        default: {
          const exhaustiveCheck: never = trackedCall;
          return {
            callId: (exhaustiveCheck as TrackedToolCall).request.callId,
            name: 'Unknown Tool',
            description: 'Encountered an unknown tool call state.',
            status: ToolCallStatus.Error,
            resultDisplay: 'Unknown tool call state',
            confirmationDetails: undefined,
            renderOutputAsMarkdown: false,
          };
        }
      }
    },
  );

  return {
    type: 'tool_group',
    tools: toolDisplays,
  };
}
