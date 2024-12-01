#!/bin/bash

# Set execute permissions for scripts
chmod +x test-filters.sh
chmod +x setup.sh

# Create necessary directories
mkdir -p vendor-php{9,10,11}
mkdir -p composer-php{9,10,11}

# Clean up any existing containers and volumes
echo "Cleaning up existing containers and volumes..."
docker-compose down -v > /dev/null 2>&1

# Function to setup a specific version
setup_version() {
    local version=$1
    echo "Setting up PHPUnit $version..."
    docker-compose build "phpunit$version" > /dev/null 2>&1
    docker-compose run --rm "phpunit$version" true > /dev/null 2>&1
}

# Setup all versions
for version in 9 10 11; do
    setup_version $version
done

echo "Setup complete. You can now run tests with:"
echo "  ./test-filters.sh -v <version> -m <method>"
echo "  ./test-filters.sh (runs all tests on all versions)" 