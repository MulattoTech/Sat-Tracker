# BabyForm Component

A form component for creating and editing baby profiles in the Baby Tracker application.

## Usage

```tsx
import BabyForm from '@/src/components/forms/BabyForm';

// In your component
const [showBabyForm, setShowBabyForm] = useState(false);
const [selectedBaby, setSelectedBaby] = useState<Baby | null>(null);
const [isEditing, setIsEditing] = useState(false);

// To open the form for creating a new baby
const handleAddBaby = () => {
  setSelectedBaby(null);
  setIsEditing(false);
  setShowBabyForm(true);
};

// To open the form for editing an existing baby
const handleEditBaby = (baby: Baby) => {
  setSelectedBaby(baby);
  setIsEditing(true);
  setShowBabyForm(true);
};

// In your JSX
<BabyForm
  isOpen={showBabyForm}
  onClose={() => setShowBabyForm(false)}
  isEditing={isEditing}
  baby={selectedBaby}
  onBabyChange={() => {
    // Handle data refresh after baby is created or updated
    fetchData();
  }}
/>
```

## Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `isOpen` | boolean | Yes | Controls the visibility of the form |
| `onClose` | () => void | Yes | Function called when the form is closed |
| `isEditing` | boolean | Yes | Determines if the form is in edit mode or create mode |
| `baby` | Baby \| null | Yes | The baby object to edit (null when creating a new baby) |
| `onBabyChange` | () => void | No | Callback function called after a baby is successfully created or updated |
| `appearance` | `'default' \| 'storybook'` | No | Defaults to `'default'` (the classic `FormPage` slide-in). `'storybook'` renders the form inside a stacked `StorybookDrawer` for use in the account manager (nests above the account-manager drawer via Radix portals). Both appearances share the same `formData` state, validation, and `handleSubmit` — only the presentation differs. |

## Features

- Create new baby profiles
- Edit existing baby profiles
- Set warning times for feeding and diaper changes
- Mark babies as inactive (when editing)
- Form validation for required fields
- Optional gestational weeks and additional days at birth, with visible validation
- Separately labelled chronological and corrected ages using the shared age helper
- Responsive layout for mobile and desktop
- Multi-family support with family ID association

## Implementation Details

The BabyForm component uses the FormPage component from the UI library to create a full-screen form that slides in from the right side of the screen. It includes:

- A header with a title and description
- A form with fields for the baby's information
- A footer with action buttons

The component handles form submission by making API calls to the `/api/baby` endpoint with the appropriate HTTP method (POST for creating, PUT for updating).

## Birth context and age display

Both appearances compose the same `GestationalAgeFields` and `ChildAgeDisplay`.
Whole weeks plus 0–6 additional days map to `gestationalAgeDays`, whose accepted
range is 1–315 days. This ceiling is a product input limit, not a definition of
prematurity. Weeks with blank additional days mean zero additional days; days
without weeks are invalid. Both fields blank mean unknown, never a term birth.

On an edit, untouched gestation is omitted from the PUT body. This also protects
legacy cached profiles that lack the new field from clearing a newer stored
value. Deliberately clearing the fields sends `null`. An unchanged birthday is
also omitted so editing gestation cannot replace a stored birth timestamp with
midnight. Selecting the same calendar birthday retains the original instant.

The preview uses the existing timezone context's explicit browser IANA timezone.
It does not invent a birth timezone or change growth, milestone, or sleep logic.
Failed saves leave inputs in place and show a visible error. Successful saves
dispatch `babyProfileChanged` so the main header can refresh from either form.

Accessible field labels are “Gestational weeks at birth” and “Additional days at
birth”. Validation uses `aria-invalid`, associated help/error text, and an alert.
The fieldset test ID is `gestational-age-inputs`; the shared age display documents
its own selectors. Browser acceptance must verify persisted values, immediate
header refresh, explicit clearing, and preservation of untouched birth context.

## Multi-Family Support

The API resolves family ownership from the authenticated session. This form does
not accept a `familyId` prop or add family ownership fields to its write payload.

## Styling

The component uses the following styling approaches:
- TailwindCSS for responsive layout and styling
- Form-specific styles defined in `baby-form.styles.ts`
- Consistent with the application's design system

## Accessibility

- Proper form labels for all input fields
- Required field validation
- Keyboard navigation support
- Focus management when the form opens and closes
