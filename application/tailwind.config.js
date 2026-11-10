/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: 'class', // This is the key setting for class-based dark mode
  theme: {
    extend: {
      colors: {
        // You can define your custom colors here
      },
    },
  },
  plugins: [],
}
