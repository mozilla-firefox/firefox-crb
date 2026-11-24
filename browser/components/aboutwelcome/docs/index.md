# Firefox Welcome Experience (<about:welcome>)

Files related to the Firefox welcome experience, which includes content that appears on `about:welcome`, can be found in the `browser/components/aboutwelcome` directory.
Some of these source files (such as `.js`, `.jsx`, and `.scss`) require an additional build step.
We are working on migrating this to work with `mach`, but in the meantime, please
follow the following steps if you need to make changes in this directory:

## For `.sys.mjs` files (system modules)

No build step is necessary. Use `mach` and run mochitests according to your regular Firefox workflow.

## For `.js`, `.jsx`, `.scss`, or `.css` files

### Prerequisites

Ensure you have installed the environment per the {doc}`contributors quick reference guide <contribution_quickref>`.

To install dependencies, run the following from the root of the Firefox repository.
(Using `mach` to call `npm` and `node` commands will ensure you're using the correct versions of Node and npm.)

```shell
(cd browser/components/aboutwelcome && ../../../mach npm ci)
```

### Which files should you edit?

You should not make changes to `.js` or `.css` files in the `browser/components/aboutwelcome/content` directory. Instead, you should edit the `.jsx`, `.js`, and `.scss` source files
in `browser/components/aboutwelcome/content-src` directory. These files will be compiled into the `.js` and `.css` files.

## Building assets and running Firefox

To build assets and run Firefox, run the following from the root of the Firefox repository:

```shell
./mach npm run bundle --prefix=browser/components/aboutwelcome && ./mach build && ./mach run
```

## Continuous development / debugging

Running `./mach npm run watchmc --prefix=browser/components/aboutwelcome` will start a process that watches files in
`aboutwelcome` and rebuilds the bundled files when JS or CSS files change.

**IMPORTANT NOTE**: This task will add inline source maps to help with debugging, which changes the memory footprint.
Do not use the `watchmc` task for profiling or performance testing!

## Running tests

<About:welcome> unit tests are written using xpcshell. To execute them, do this:

```shell
./mach xpcshell-test --prefix=browser/components/aboutwelcome
```

Mochitests run normally, using `./mach mochitest browser/components/aboutwelcome`.

[node.js homepage]: https://nodejs.org/
