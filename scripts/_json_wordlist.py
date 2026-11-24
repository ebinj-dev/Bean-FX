"""Emit a JSON array of the whitespace-separated words in argv[1] (M42-A)."""
import json, sys
print(json.dumps(sys.argv[1].split()))
