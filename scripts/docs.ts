import { Octokit } from "octokit";
import openai from 'openai';
import { SupabaseClient } from '@supabase/supabase-js';
import { generateEmbeddings } from './embeddingCreation/createSectionEmbeddings';

export interface ProcessDocsParams {
  supabase: SupabaseClient;
  openai: openai;
  octokit: Octokit
  repoOwner: string;
  repoName: string;
  pathToRepoDocuments: string;
  documentationFileExt: string;
  sectionDelimiter: string;
  sourceDocumentationUrl: string;
}

/**
 * Prints the documentation URL and sections for a document. Used for testing.
 * @param {string[]} sections - All the sections from a document.
 * @param {string} docURL - The URL where the documentation is located.
 */
function printSectionizedDocument(
  sections: string[],
  docURL: string
) {
  console.log(`https://aframe.io/docs/master/${docURL}\n`);
  sections.forEach((section, index) => {
    // console.log(`Section ${index + 1}:`);
    // console.log(section.trim() + '\n');
  });
}
  
/**
 * Splits a document into logical sections by a delimiter.
 * Currently only works for Markdown (.MD) files.
 * @param {string} documentContent - The content of the file.
 * @param {string} sectionDelimiter - Character sequence to sectionize the file content.
 * @returns {object} - The document sections (`sections`) and documentation URL (`url`).
 */
function sectionizeDocument(
  documentContent: string,
  sectionDelimiter: string
) {
  // Retrieve YAML header and extract out documentation url path.
  const yamlHeader = documentContent.match(/---\n([\s\S]+?)\n---/);
  // let documentationUrl = ""
  // if (yamlHeader) {
  //     let section = yamlHeader[1].trim();
  //     const matchResult = section.match(/source_code:\s*src\/(.+)/);

  //     if (matchResult && matchResult[1]) {
  //       documentationUrl = matchResult[1].trim().replace(/\.js$/, '');
  //     } else {
  //         // Handle the case where the match or the group [1] is null or undefined.
  //         console.error('Unable to extract source code URL from YAML header:', section);
  //     }
  // } 

  // Split the remaining content into sections based on the YAML header and delimiter.
  const delim = new RegExp(`\\n+${sectionDelimiter}+\\s+`);
  const sections = documentContent
      .replace(yamlHeader ? yamlHeader[0] : '', '')
      .split(delim);

  // Debug
  //printSectionizedDocument(sections, documentationUrl);

  return { sections: sections };
}
  
/**
 * Retrieves, processes, and stores all documents on a GitHub repository to a
 * pgvector in Supabase. Currently only supports Markdown (.MD) files.
 * @param {ProcessDocsParams} params - An object that conforms to the ProcessDocsParams interface.
 */
export async function vectorizeDocuments(
  params: ProcessDocsParams
) {
  try {
    const {
      supabase,
      openai,
      octokit,
      repoOwner,
      repoName,
      pathToRepoDocuments,
      documentationFileExt,
      sectionDelimiter,
      sourceDocumentationUrl
    } = params

    // Fetch the documentation directories or files.
    let response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: repoOwner,
      repo: repoName,
      path: pathToRepoDocuments,
      headers: {
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    response.data = Array.isArray(response.data) ? response.data : [response.data];

    console.log('arra1: ', response.data.length)

    // Process documents in each directory.
    for (const resData of response.data) {
      let dirDocuments = [];
      if (resData.type == 'dir') {
        // Fetch all files from the directory.
        response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
          owner: repoOwner,
          repo: repoName,
          path: pathToRepoDocuments + "/" + resData.name,
          headers: {
            'X-GitHub-Api-Version': '2022-11-28'
          }
        })

      // Type assertion for response.data
      const documentsArray = response.data as any[];

      dirDocuments = documentsArray.filter((document) => 
        document.name.endsWith(`.${documentationFileExt}`)
      );
      } else if (resData.type == 'file') {
        dirDocuments = [resData];
      } else {
        throw new Error('Repository URL does not exist!');
      }
      //console.log(dirDocuments)

      // Retrieve document data for all docs to process.
      await Promise.all(
        dirDocuments.map(async (document) => {
          const contentResponse = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner: repoOwner,
            repo: repoName,
            path: document.path,
            headers: {
              'X-GitHub-Api-Version': '2022-11-28' 
            }
          })

          const decodedContent = Buffer.from((contentResponse.data as { content: string }).content, "base64").toString("utf-8");
          const { sections } = sectionizeDocument(
            decodedContent,
            sectionDelimiter
          );
          let updatedPath = document.path.replace("docs/", "");
          await generateEmbeddings(sections, sourceDocumentationUrl + updatedPath, supabase, openai);
        })
      );
    }
  } catch (error) {
    console.error('Error fetching data from GitHub API:', error);
  }
}
  
/**
 * Retrieves and processes a list of all documentation documents modified from a pull request.
 * @param {ProcessDocsParams} params - An object that conforms to the ProcessDocsParams interface.
 * @param {string} pullRequestNum - The pull request number.
 */
export async function fetchLatestPullRequest(
  params: ProcessDocsParams,
  pullRequestNum: string
) {
  try {
    const {
      octokit,
      repoOwner,
      repoName,
      pathToRepoDocuments
    } = params

    let page = 1;

    while (true) {
      console.log("ABOUT TO GET RESPONSE");
      
      const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
        owner: repoOwner,
        repo: repoName,
        pull_number: parseInt(pullRequestNum),
        per_page: 100,
        page: page,
        headers: {
          'X-GitHub-Api-Version': '2022-11-28'
        }
      });

      console.log("RESPONSE LENGTH: " + JSON.stringify(response.data));
      console.log("test2", response.data.length)

      await Promise.all(response.data.map(async (filePath: any) => {
        console.log('filePath:', filePath)
        if (filePath.filename.includes(`${pathToRepoDocuments}/`)) {
          params.pathToRepoDocuments = filePath.filename;
          await vectorizeDocuments(params);
        }
      }));
      
      break;
    }
  } catch (error) {
    console.error('Error fetching data from GitHub API:', error);
  }
}
