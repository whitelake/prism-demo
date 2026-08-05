# PoC Invariant Review Checklist

## Tool context

- Tool System Prompt is static
- No questionnaire or examiner history is passed
- Only current task history is loaded
- No assessment identifier is sent as model user metadata
- Logged request matches the expected context exactly

## Evaluation locking

- Report endpoint is filtered server-side
- List endpoint is filtered server-side
- B submission does not immediately reveal A
- `final_evaluating` remains locked
- Alternate endpoints do not expose evaluation entities

## Signals

- Candidate APIs do not return signals
- Interviewer APIs do not return signals
- Raw-log DTOs do not accidentally serialize signals
- Signals remain available for state decisions and offline export

## Model calls

- All calls use the unified client
- Request is logged before network execution
- Raw response is preserved
- Failures are logged
- Outline and evaluation are independent calls

## State machine

- State transitions occur only through the approved state logic
- Model output is treated as input, not a command
- Only declared signal fields are consumed
- Retry paths do not bypass locking or logging
