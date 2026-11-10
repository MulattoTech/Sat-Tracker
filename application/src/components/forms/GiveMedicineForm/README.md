# GiveMedicineForm Component

A standalone form component for recording medicine administration in the baby tracker application. This component was extracted from the original MedicineForm's GiveMedicineTab to follow the same patterns as other forms in the app (like CaretakerForm).

## Features

- Standalone form using the FormPage component for consistent UI
- Medicine selection with dropdown interface
- Date and time picker for administration time
- Dose amount and unit selection
- Optional notes field
- Form validation with error handling
- Support for both creating new entries and editing existing ones
- Responsive design for mobile and desktop

## Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `isOpen` | boolean | Yes | Controls whether the form is visible |
| `onClose` | () => void | Yes | Function to call when the form should be closed |
| `babyId` | string \| undefined | Yes | ID of the baby for whom medicine is being administered |
| `initialTime` | string | Yes | Initial time value for the form (ISO format) |
| `onSuccess` | () => void | No | Optional callback function called after successful submission |
| `refreshData` | () => void | No | Optional function to refresh parent component data |
| `activity` | any | No | Existing medicine log data (for edit mode) |
| `onPendingChange` | (pending: boolean) => void | No | Reports a saved, unconfirmed dose for the current caregiver and child |

## Usage

```tsx
import GiveMedicineForm from '@/src/components/forms/GiveMedicineForm';

function MyComponent() {
  const [showGiveMedicineForm, setShowGiveMedicineForm] = useState(false);
  const [selectedBaby, setSelectedBaby] = useState<{ id: string }>();
  
  const handleGiveMedicineSuccess = () => {
    setShowGiveMedicineForm(false);
    // Refresh data or perform other actions
  };
  
  return (
    <>
      <Button onClick={() => setShowGiveMedicineForm(true)}>
        Give Medicine
      </Button>
      
      <GiveMedicineForm
        isOpen={showGiveMedicineForm}
        onClose={() => setShowGiveMedicineForm(false)}
        babyId={selectedBaby?.id}
        initialTime={new Date().toISOString()}
        onSuccess={handleGiveMedicineSuccess}
        refreshData={() => {
          // Refresh parent data
        }}
      />
    </>
  );
}
```

## Integration with MedicineForm

The GiveMedicineForm is now integrated with the MedicineForm through:

1. **ActiveDosesTab**: Contains a "Give Medicine" button that opens the GiveMedicineForm
2. **Overlay Pattern**: The GiveMedicineForm appears as an overlay on top of the MedicineForm
3. **Data Refresh**: After successful submission, both forms refresh their data

## Implementation Details

- Uses the same FormPage component as other forms for consistency
- Fetches medicines and units data from the API when opened
- Implements proper form validation for all required fields
- Handles both create and edit modes based on the `activity` prop
- Follows the project's TypeScript patterns and error handling
- Maintains functionality from the original GiveMedicineTab while using consistent theming

## API Integration

The form integrates with the following API endpoints:
- `GET /api/medicine?active=true` - Fetch active medicines
- `GET /api/units?activityType=medicine` - Fetch medicine units
- `POST /api/medicine-log` - Create new medicine log entry
- `PUT /api/medicine-log?id={id}` - Update existing medicine log entry

### Recovering an unconfirmed new dose

Before creating a dose, the form saves its request UUID, authenticated caregiver,
family, child, medicine, first administration time, quantity, unit, and notes in
browser storage. A short Web Lock protects the exact saved request from competing
tabs. If storage or locking is unavailable, the form retains the editable inputs
and blocks dispatch until the caregiver restores storage access.

A failed, rejected, or timed-out request stays visible as a read-only summary.
Closing the dialog, refreshing, or restarting the browser retains this summary
for the original caregiver and child. The Medicine Tracker exposes **Review saved
dose** even when the entry dialog is closed. **Retry saved dose** sends the same
UUID and values; it never creates a replacement intent from an absent or newer
saved request. Fetch, shared authentication refresh, and response parsing have one
20-second deadline. No retry is automatic.

The create endpoint atomically stores the dose and an `ExternalImportRecord`
receipt. It acknowledges an existing request only when the stored dose still
matches all original clinical, ownership, and revision fields. A corrected,
moved, or removed record requires review instead of recreation. The caregiver can
open the care log and explicitly dismiss only the exact saved browser request;
this does not delete or alter any care record. An intentional new administration
gets a new UUID even if all its values match an earlier administration.

Older API callers may omit this optional metadata. Editing an existing dose
continues to use the existing PUT behavior, and active-dose calculations are
unchanged.

## Accessibility

- Proper form labels for all input fields
- Required field validation with clear error messages
- Keyboard navigation support
- Focus management when the form opens and closes
- ARIA attributes for improved screen reader support

## Mobile Considerations

This component follows the project's cross-platform compatibility guidelines:
- Uses touch-friendly button sizes and spacing
- Responsive design that works on mobile screens
- Recovery requires persistent browser storage and Web Locks; unavailable storage
  blocks a new dispatch without discarding the current inputs
- Retains uncertain requests while offline for an explicit retry after reconnecting
