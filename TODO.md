# TODO

- **Improve error handling**: Some async operations in `main.ts` and `FileBrowserView.tsx` only log errors. Implement clearer user feedback and recovery steps.
- **Add automated tests**: There are no automated tests for ID validation, graph building or commands. Adding tests would help maintain stability.
- **Resolve remaining ESLint issues**: Several files still trigger lint warnings and errors. Clean up unused variables and convert dynamic `require` calls to `import` statements where possible.
