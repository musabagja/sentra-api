// Telemetry must start before the app is imported so auto-instrumentation can
// patch express/http. Tests import ./app directly and skip this entirely.
import './tracer';

import app from './app';

const port = process.env.PORT || 5000;

app.listen(port, () => {
  console.log("Listening on " + port);
});
