import { NextApiRequest, NextApiResponse } from "next";

import { parsePageId } from "notion-utils";

import { sendVerificationEmail } from "@/lib/emails/send-email-verification";
import { getFile } from "@/lib/files/get-file";
import { newId } from "@/lib/id-helper";
import notion from "@/lib/notion";
import prisma from "@/lib/prisma";
import { parseSheet } from "@/lib/sheet";
import { checkPassword, decryptEncrpytedPassword, log } from "@/lib/utils";

export default async function handle(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  // We only allow POST requests
  if (req.method !== "POST") {
    res.status(405).json({ message: "Method Not Allowed" });
    return;
  }
  // POST /api/views-dataroom
  const {
    linkId,
    documentId,
    dataroomId,
    userId,
    documentVersionId,
    documentName,
    hasPages,
    token,
    ownerId,
    verifiedEmail,
    dataroomVerified,
    linkType,
    dataroomViewId,
    viewType,
    ...data
  } = req.body as {
    linkId: string;
    documentId: string | undefined;
    dataroomId: string | undefined;
    userId: string | null;
    documentVersionId: string | undefined;
    documentName: string | undefined;
    hasPages: boolean | undefined;
    token: string | null;
    ownerId: string | null;
    verifiedEmail: string | null;
    dataroomVerified: boolean | undefined;
    linkType: string;
    dataroomViewId?: string;
    viewType: "DATAROOM_VIEW" | "DOCUMENT_VIEW";
  };

  const { email, password } = data as { email: string; password: string };

  // Fetch the link to verify the settings
  const link = await prisma.link.findUnique({
    where: {
      id: linkId,
    },
    select: {
      emailProtected: true,
      enableNotification: true,
      emailAuthenticated: true,
      password: true,
      domainSlug: true,
      isArchived: true,
      slug: true,
      allowList: true,
      denyList: true,
    },
  });

  if (!link) {
    res.status(404).json({ message: "Link not found." });
    return;
  }

  if (link.isArchived) {
    res.status(404).json({ message: "Link is no longer available." });
    return;
  }

  // Check if email is required for visiting the link
  if (link.emailProtected) {
    if (!email || email.trim() === "") {
      res.status(400).json({ message: "Email is required." });
      return;
    }
  }

  // Check if password is required for visiting the link
  if (link.password) {
    if (!password || password.trim() === "") {
      res.status(400).json({ message: "Password is required." });
      return;
    }

    let isPasswordValid: boolean = false;
    const textParts: string[] = link.password.split(":");
    if (!textParts || textParts.length !== 2) {
      isPasswordValid = await checkPassword(password, link.password);
    } else {
      const decryptedPassword = decryptEncrpytedPassword(link.password);
      isPasswordValid = decryptedPassword === password;
    }

    if (!isPasswordValid) {
      res.status(403).json({ message: "Invalid password." });
      return;
    }
  }

  // Check if email is allowed to visit the link
  if (link.allowList && link.allowList.length > 0) {
    // Extract the domain from the email address
    const emailDomain = email.substring(email.lastIndexOf("@"));

    // Determine if the email or its domain is allowed
    const isAllowed = link.allowList.some((allowed) => {
      return (
        allowed === email ||
        (allowed.startsWith("@") && emailDomain === allowed)
      );
    });

    // Deny access if the email is not allowed
    if (!isAllowed) {
      res.status(403).json({ message: "Unauthorized access" });
      return;
    }
  }

  // Check if email is denied to visit the link
  if (link.denyList && link.denyList.length > 0) {
    // Extract the domain from the email address
    const emailDomain = email.substring(email.lastIndexOf("@"));

    // Determine if the email or its domain is denied
    const isDenied = link.denyList.some((denied) => {
      return (
        denied === email || (denied.startsWith("@") && emailDomain === denied)
      );
    });

    // Deny access if the email is denied
    if (isDenied) {
      res.status(403).json({ message: "Unauthorized access" });
      return;
    }
  }

  // Check if email verification is required for visiting the link
  if (link.emailAuthenticated && !token && !dataroomVerified) {
    const token = newId("email");
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 20); // token expires in 20 minutes

    await prisma.verificationToken.create({
      data: {
        token,
        identifier: `${linkId}:${email}`,
        expires: expiresAt,
      },
    });

    // set the default verification url
    let verificationUrl: string = `${process.env.NEXT_PUBLIC_BASE_URL}/view/${linkId}/?token=${token}&email=${encodeURIComponent(email)}`;

    if (link.domainSlug && link.slug) {
      // if custom domain is enabled, use the custom domain
      verificationUrl = `https://${link.domainSlug}/${link.slug}/?token=${token}&email=${encodeURIComponent(email)}`;
    }

    await sendVerificationEmail(email, verificationUrl);
    res.status(200).json({
      type: "email-verification",
      message: "Verification email sent.",
    });
    return;
  }

  let isEmailVerified: boolean = false;
  if (link.emailAuthenticated && token && !dataroomVerified) {
    const verification = await prisma.verificationToken.findUnique({
      where: {
        token: token,
        identifier: `${linkId}:${verifiedEmail}`,
      },
    });

    if (!verification) {
      res.status(401).json({
        message: "Unauthorized access. Request new access.",
        resetVerification: true,
      });
      return;
    }

    // Check the token's expiration date
    if (Date.now() > verification.expires.getTime()) {
      res.status(401).json({ message: "Access expired" });
      return;
    }

    // delete the token after verification
    await prisma.verificationToken.delete({
      where: {
        token: token,
      },
    });

    isEmailVerified = true;
  }

  if (link.emailAuthenticated && dataroomVerified) {
    isEmailVerified = true;
  }

  let viewer: { id: string } | null = null;
  if (email) {
    // find or create a viewer
    console.time("find-viewer");
    viewer = await prisma.viewer.findUnique({
      where: {
        dataroomId_email: {
          email: email,
          dataroomId: dataroomId!,
        },
      },
      select: { id: true },
    });
    console.timeEnd("find-viewer");

    if (!viewer) {
      console.time("create-viewer");
      viewer = await prisma.viewer.create({
        data: {
          email: email,
          dataroomId: dataroomId!,
          verified: isEmailVerified,
        },
        select: { id: true },
      });
      console.timeEnd("create-viewer");
    }
  }

  // what's the difference between || and ?? on the viewer.id assignment?
  // viewer?.id ?? undefined
  // viewer?.id || undefined
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Nullish_coalescing_operator

  if (viewType === "DATAROOM_VIEW") {
    try {
      console.time("create-view");
      const newDataroomView = await prisma.view.create({
        data: {
          linkId: linkId,
          viewerEmail: email,
          verified: isEmailVerified,
          dataroomId: dataroomId,
          viewType: "DATAROOM_VIEW",
          viewerId: viewer?.id ?? undefined,
        },
        select: { id: true },
      });
      console.timeEnd("create-view");

      const returnObject = {
        message: "Dataroom View recorded",
        viewId: newDataroomView.id,
        file: undefined,
        pages: undefined,
        notionData: undefined,
      };

      return res.status(200).json(returnObject);
    } catch (error) {
      log({
        message: `Failed to record view for dataroom link: ${linkId}. \n\n ${error}`,
        type: "error",
        mention: true,
      });
      return res.status(500).json({ message: (error as Error).message });
    }
  }

  try {
    console.time("create-view");
    const newView = await prisma.view.create({
      data: {
        linkId: linkId,
        viewerEmail: email,
        documentId: documentId,
        verified: isEmailVerified,
        dataroomViewId: dataroomViewId,
        dataroomId: dataroomId,
        viewType: "DOCUMENT_VIEW",
        viewerId: viewer?.id ?? undefined,
      },
      select: { id: true },
    });
    console.timeEnd("create-view");

    // if document version has pages, then return pages
    // otherwise, check if notion document,
    // if notion, return recordMap from document version file
    // otherwise, return file from document version
    let documentPages, documentVersion;
    let recordMap;
    let columnData, rowData;

    if (hasPages) {
      // get pages from document version
      console.time("get-pages");
      documentPages = await prisma.documentPage.findMany({
        where: { versionId: documentVersionId },
        orderBy: { pageNumber: "asc" },
        select: {
          file: true,
          storageType: true,
          pageNumber: true,
          embeddedLinks: true,
        },
      });

      documentPages = await Promise.all(
        documentPages.map(async (page) => {
          const { storageType, ...otherPage } = page;
          return {
            ...otherPage,
            file: await getFile({ data: page.file, type: storageType }),
          };
        }),
      );

      console.timeEnd("get-pages");
    } else {
      // get file from document version
      console.time("get-file");
      documentVersion = await prisma.documentVersion.findUnique({
        where: { id: documentVersionId },
        select: {
          file: true,
          storageType: true,
          type: true,
        },
      });

      if (!documentVersion) {
        res.status(404).json({ message: "Document version not found." });
        return;
      }

      if (documentVersion.type === "pdf") {
        documentVersion.file = await getFile({
          data: documentVersion.file,
          type: documentVersion.storageType,
        });
      }

      if (documentVersion.type === "notion") {
        let notionPageId = parsePageId(documentVersion.file, { uuid: false });
        if (!notionPageId) {
          notionPageId = "";
        }

        const pageId = notionPageId;
        recordMap = await notion.getPage(pageId);
      }

      if (documentVersion.type === "sheet") {
        const fileUrl = await getFile({
          data: documentVersion.file,
          type: documentVersion.storageType,
        });

        const data = await parseSheet({ fileUrl });
        columnData = data.columnData;
        rowData = data.rowData;
      }
      console.timeEnd("get-file");
    }

    const returnObject = {
      message: "View recorded",
      viewId: newView.id,
      file:
        documentVersion && documentVersion.type === "pdf"
          ? documentVersion.file
          : undefined,
      pages: documentPages ? documentPages : undefined,
      notionData: recordMap ? { recordMap } : undefined,
      sheetData:
        documentVersion && documentVersion.type === "sheet"
          ? { columnData, rowData }
          : undefined,
    };

    return res.status(200).json(returnObject);
  } catch (error) {
    log({
      message: `Failed to record view for dataroom ${linkId}. \n\n ${error}`,
      type: "error",
      mention: true,
    });
    return res.status(500).json({ message: (error as Error).message });
  }
}
