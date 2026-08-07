// Ensure tests always run with NODE_ENV=test so the AI provider forces the
// deterministic local mock and never reaches the network, and the job runner
// does not auto-start.
process.env.NODE_ENV = 'test';
