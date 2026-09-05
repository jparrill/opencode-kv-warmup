.PHONY: test lint check clean

test:
	node --test test/

lint:
	@echo "Checking syntax..."
	@node -c plugin.js
	@echo "All files OK"

check: lint test

clean:
	rm -rf .work/
