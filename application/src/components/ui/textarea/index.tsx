import * as React from "react"
import { cn } from "@/src/lib/utils"
import { textareaStyles } from "./textarea.styles"
import { TextareaProps } from "./textarea.types"
import { useTheme } from "@/src/context/theme"
import "./textarea.css"

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    const { theme } = useTheme();
    
    return (
      <textarea
        className={cn(textareaStyles.base, className, "textarea")}
        ref={ref}
        {...props}
      />
    )
  }
)
Textarea.displayName = "Textarea"

export { Textarea }
