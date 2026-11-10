# PumpForm Component

A form component for recording and editing breast pumping activities in the Baby Tracker application.

## Features

- Records start and end times for pumping sessions
- Tracks left and right breast amounts separately with intuitive increment/decrement controls
- Automatically calculates total amount based on left and right amounts
- Supports different measurement units (oz, ml) with easy toggle buttons
- Allows adding notes for each session
- Handles both creation and editing of pump records
- Follows the application's form design pattern
- Supports dark mode with appropriate styling
- Multi-family support with family ID association

## Usage

```tsx
import PumpForm from '@/src/components/forms/PumpForm';
import { useFamily } from '@/src/context/family'; // Import family context
import { useState } from 'react';

function ParentComponent() {
  const [showPumpForm, setShowPumpForm] = useState(false);
  const [selectedBaby, setSelectedBaby] = useState({ id: 'baby-id' });
  const { family } = useFamily(); // Get current family from context
  
  return (
    <>
      <button onClick={() => setShowPumpForm(true)}>
        Record Pumping Session
      </button>
      
      <PumpForm
        isOpen={showPumpForm}
        onClose={() => setShowPumpForm(false)}
        babyId={selectedBaby?.id}
        initialTime={new Date().toISOString()}
        familyId={family?.id} // Pass the current family ID
        onSuccess={() => {
          // Refresh data or show success message
        }}
      />
    </>
  );
}
```

## Component API

### PumpForm

Main component for recording breast pumping activities.

#### Props

| Prop | Type | Description | Default |
|------|------|-------------|---------|
| `isOpen` | `boolean` | Controls whether the form is visible | Required |
| `onClose` | `() => void` | Function to call when the form should be closed | Required |
| `babyId` | `string \| undefined` | ID of the baby for whom the activity is being recorded | Required |
| `initialTime` | `string` | Initial time value for the form (ISO format) | Required |
| `activity` | `PumpLogResponse` | Existing activity data (for edit mode) | `undefined` |
| `onSuccess` | `() => void` | Optional callback function called after successful submission | `undefined` |
| `familyId` | `string` | The ID of the family this pump record belongs to (for multi-family support) | `undefined` |

## Form Fields

The form includes the following fields:

1. **Start Time**: When the pumping session began (required)
2. **End Time**: When the pumping session ended (optional)
3. **Left Amount**: Amount pumped from left breast with increment/decrement buttons (optional)
4. **Right Amount**: Amount pumped from right breast with increment/decrement buttons (optional)
5. **Total Amount**: Total amount pumped (calculated automatically)
6. **Unit**: Measurement unit (oz or ml) with toggle buttons
7. **Notes**: Additional notes about the session (optional)

## Behavior

- When both start and end times are provided, the duration is automatically calculated
- When left and/or right amounts are entered, the total amount is automatically calculated
- The form validates that amount fields contain valid numeric values
- The form handles both creation of new records and editing of existing ones

## Implementation Details

The component uses the following UI components from the application's component library:

- `FormPage`, `FormPageContent`, `FormPageFooter` for layout
- `DateTimePicker` for date and time selection
- `Input` for text inputs
- `Textarea` for multiline text input
- `Button` for form actions and increment/decrement controls
- `Label` for form field labels
- Lucide React icons (`Plus`, `Minus`) for increment/decrement buttons

The component follows the standard form initialization pattern to prevent form resets when the `initialTime` prop changes.

### User Experience Improvements

- Unit selection buttons positioned at the top for easy access
- Left and right amount inputs on separate rows for better clarity
- Larger input fields with increased text size for better readability
- Increment/decrement buttons for easy adjustment of amounts
- Automatic calculation of total amount as left and right amounts are changed
- Appropriate step sizes for increments (0.5 for oz, 5 for ml)
- Descriptive form title and description
- Dark mode support with custom styling

## API Integration

The form submits data to the `/api/pump-log` endpoint, using:
- POST for creating new records
- PUT with an ID parameter for updating existing records

The form includes the authentication token in the request headers for secure API access.

The editor captures the original record when it opens and sends its exact
`updatedAt` string as `expectedUpdatedAt` on every PUT. A completed edit made
after that baseline returns `409` before changing the pump or its owned feed.
The transaction separately claims the entire server-read record to protect
overlapping requests, including writers that share a millisecond timestamp.
Canonical edits advance `updatedAt` by at least one millisecond.

A conflict keeps the form open with its unsaved values and disables submission.
**Load latest record** retrieves the saved values for comparison without
changing the draft or its revision. **Replace draft with latest values** is the
explicit discard action: it loads those values into the form, after which the
caregiver can enter a reviewed correction. A subsequent intervening edit still
causes another conflict. Failed reloads retain the draft; there is no automatic
retry or field merging. Closing/reloading the entire page does not persist an
ordinary edit draft.

The precondition is optional for legacy API clients. A present value must match
the API's canonical UTC millisecond format; invalid values return `400`, and
stale values return `409`. Legacy clients that omit it retain overlapping-write
protection but do not gain late stale-form detection. Empty and same-value
corrections remain valid and preserve care fields while advancing the revision.

### Owned feeding records

Canonical pumping corrections and deletions use the same atomic reconciliation
as hooks. A directly linked feed must belong to the pump's original family and
child. An unlinked legacy feed is adopted only when its original caregiver,
time, positive quantity, unit, and exact generated notes match one pump
unambiguously. A similar timestamp or note prefix alone does not prove ownership.
Missing quantities and `UNKNOWN` disposition never identify a legacy feed.
Ambiguous ownership, inconsistent source links, and independently soft-deleted
feeds return `409` without changing either record. Already deleted pumps cannot
be corrected or deleted again. Deletion claims the complete server-read pump
snapshot, so an overlapping correction cannot be silently erased.

Ownership and removed-record conflicts carry `PUMP_RECONCILIATION_REQUIRED` with
a safe explanation. The editor keeps the draft, displays the reason, and allows
the latest pump values to be inspected. It keeps saving and draft replacement
blocked: loading a pump alone cannot repair ambiguous feeding ownership. The
caregiver must review the pumping and feeding history before reopening the
correction. Ordinary revision conflicts retain their explicit reload/replace
workflow; neither conflict automatically retries a write.

An explicit correction to another child in the same authenticated family remains
supported. Ownership is checked against the original child first, then the pump
and its one owned feed move together. The original caregiver attribution is
preserved, and unrelated feeds for either child remain unchanged. A target child
outside that family or already deleted is rejected before any care write. These changes do not
introduce client revision preconditions for DELETE or for legacy PUT callers.

### Multi-Family Support

The API obtains the family from the authenticated context. Record lookup and the
conditional update both enforce that family, and a requested baby reassignment
must remain within it. Client-supplied family identifiers are not authoritative.

## Cross-Platform Considerations

This component is designed with cross-platform compatibility in mind:
- Uses standard React patterns that can be adapted to React Native
- Avoids web-specific APIs where possible
- Uses relative sizing that can be adapted to different screen sizes
- Implements touch-friendly input controls with appropriately sized buttons
- Separates styling concerns with CSS files for easier platform-specific styling
- Uses a modular approach that can be adapted to different platforms
## Unresolved imported milk

Baby Buddy pumping imports use `UNKNOWN` because the export has no disposition.
The form displays **Needs review** and explains its effect on milk stock. The
existing Stored, Fed and Discarded choices explicitly resolve it; leaving Needs
review selected preserves the uncertainty. It remains available for imported
unknown sessions even when breast-milk tracking is off. Changed-field updates
preserve untouched source timestamps, duration, notes and nullable amounts.
