#!/bin/bash

while getopts "v:m:" flag; do
    case "${flag}" in
        v) VERSION=${OPTARG};;
        m) METHOD=${OPTARG};;
    esac
done

CLASS="DataProviderTest"
FILTER_BASE="--filter"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

run_test() {
    local version=$1
    local pattern=$2
    local description=$3
    
    echo -e "${GREEN}----------------------------------------${NC}"
    echo -e "${GREEN}$description${NC}\n"
    echo -e "${BLUE}Testing PHPUnit $version with pattern: $pattern${NC}\n"
    echo -e "${GREEN}----------------------------------------${NC}"
    
    cmd="docker-compose run -T --rm phpunit$version vendor/bin/phpunit --testdox --colors=always --configuration phpunit.xml $FILTER_BASE=\"$pattern\""
    echo -e "Command: ${BLUE}$cmd${NC}\n"
    
    eval "$cmd"
    
    echo -e "${GREEN}----------------------------------------${NC}\n"
}

test_version_patterns() {
    local version=$1
    local method=$2

    run_test "$version" "$CLASS::$method($| with data set .*$)" "PHPUnit $version data provider pattern"
}

VERSIONS=(9 10 11)
METHODS=(testAdd testMultiply testSimple)

if [ -z "$VERSION" ] && [ -z "$METHOD" ]; then
    echo "Running all tests on all versions"
    for v in "${VERSIONS[@]}"; do
        for m in "${METHODS[@]}"; do
            test_version_patterns "$v" "$m"
        done
    done
    exit 0
fi

if [ -z "$METHOD" ]; then
    echo "Usage: ./test-filters.sh -v <version> -m <method>"
    echo "Available phpunit versions (-v): 9, 10, 11 (empty for all)"
    echo "Methods (-m): testAdd, testMultiply, testSimple (empty for all)"
    echo "Leave both empty to run all tests on all versions"
    exit 1
fi

if [ -n "$VERSION" ]; then
    if [[ ! " ${VERSIONS[@]} " =~ " ${VERSION} " ]]; then
        echo -e "${RED}Invalid version. Available versions: 9, 10, 11${NC}"
        exit 1
    fi
    VERSIONS=($VERSION)
fi

for v in "${VERSIONS[@]}"; do
    test_version_patterns "$v" "$METHOD"
done