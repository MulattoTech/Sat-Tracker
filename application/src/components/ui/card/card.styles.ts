export const cardStyles = {
  base: "border border-slate-200 bg-white/80 text-card-foreground shadow-lg backdrop-blur-sm transition-all duration-200 hover:shadow-xl hover:bg-white/90",
  base2: "bg-white/80 text-card-foreground shadow-lg backdrop-blur-sm transition-all duration-200 hover:shadow-xl hover:bg-white/90",
  header: "flex flex-col space-y-1.5 p-6",
  title: "text-2xl font-semibold leading-none tracking-tight bg-gradient-to-r from-teal-600 to-emerald-600 bg-clip-text text-transparent",
  description: "text-sm text-gray-500",
  content: "p-6 pt-0",
  footer: "flex items-center p-6 pt-0"
} as const;
